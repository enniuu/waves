mod cache;
mod constants;
mod encoding;
mod folio;
mod helpers;
mod proxy;
mod rewrite;
mod safe_dns;
mod state;
mod stream;
mod tuning;
mod websocket;

pub(crate) const NEGATIVE: &str = "... /ᐠ - ˕ -マ";
pub(crate) const POSITIVE: &str = "!! (˵◝ ⩊  ◜˵マ";

fn message_base(mut message: &str) -> &str {
    loop {
        if let Some(base) = message
            .strip_suffix(NEGATIVE)
            .or_else(|| message.strip_suffix(POSITIVE))
        {
            message = base.trim_end();
        } else {
            return message.trim_end_matches(['.', '!']);
        }
    }
}

pub(crate) fn negative_message(message: &str) -> String {
    format!("{}{NEGATIVE}", message_base(message))
}

#[cfg(test)]
pub(crate) fn positive_message(message: &str) -> String {
    format!("{}{POSITIVE}", message_base(message))
}

use adaptive_capacity::{spawn_rebalancer, AdaptiveGate, CapacityTarget, Workload};
use aho_corasick::AhoCorasick;
use axum::http::{header::CONTENT_RANGE, Extensions, HeaderMap, StatusCode, Version};
use axum::{routing::any, Router};
use dashmap::DashMap;
use mimalloc::MiMalloc;
use moka::future::Cache;
use reqwest::{redirect::Policy, Client};
use state::{AppState, CachedResponse, FolioMetrics};
use std::error::Error;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tower_http::compression::{
    predicate::{DefaultPredicate, NotForContentType, Predicate},
    CompressionLayer,
};
use tower_http::cors::{Any, CorsLayer};

const BROWSER_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

type AppResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

fn main() -> AppResult<()> {
    tracing_subscriber::fmt()
        .with_env_filter("mochi=info")
        .init();

    let tuning = tuning::detect();

    tracing::info!(
        "tuning: {} workers, {}mb cache cap, {}mb stream cache, {}mb max entry, {}mb stream max entry, {}mb ram limit, req permits {}/{}/{}, stream permits {}/{}/{}, rewrite permits {}/{}/{}, {}gb disk cache",
        tuning.worker_threads,
        tuning.cache_capacity_bytes / (1024 * 1024),
        tuning.stream_cache_capacity_bytes / (1024 * 1024),
        tuning.max_cache_entry_size / (1024 * 1024),
        tuning.stream_max_entry_size / (1024 * 1024),
        tuning.ram_cache_limit / (1024 * 1024),
        tuning.request_permits_min,
        tuning.request_permits,
        tuning.request_permits_max,
        tuning.stream_upstream_permits_min,
        tuning.stream_upstream_permits,
        tuning.stream_upstream_permits_max,
        tuning.html_rewrite_permits_min,
        tuning.html_rewrite_permits,
        tuning.html_rewrite_permits_max,
        tuning.disk_cache_bytes / (1024 * 1024 * 1024),
    );

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(tuning.worker_threads)
        .enable_all()
        .build()?;

    runtime.block_on(async_main(tuning))
}

fn public_redirect_policy() -> Policy {
    Policy::custom(|attempt| {
        let url = attempt.url();
        let port_allowed = url
            .port_or_known_default()
            .is_some_and(|port| port == 80 || port == 443 || port >= 1024);
        let host_allowed = url
            .host_str()
            .map(|host| {
                let normalized = host.trim_end_matches('.').to_ascii_lowercase();
                !normalized.is_empty()
                    && normalized != "localhost"
                    && !normalized.ends_with(".localhost")
                    && !normalized.ends_with(".local")
                    && !normalized.ends_with(".internal")
                    && !normalized.ends_with(".home.arpa")
                    && normalized
                        .parse::<std::net::IpAddr>()
                        .map(safe_dns::is_public_ip)
                        .unwrap_or(true)
            })
            .unwrap_or(false);

        if (url.scheme() != "http" && url.scheme() != "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || !port_allowed
            || !host_allowed
        {
            attempt.error("redirect target is not allowed... /ᐠ - ˕ -マ")
        } else {
            attempt.follow()
        }
    })
}

async fn async_main(tuning: tuning::MochiTuning) -> AppResult<()> {
    tokio::fs::create_dir_all("./cache/stream").await?;

    let cache = Cache::builder()
        .max_capacity(tuning.cache_capacity_bytes)
        .weigher(|_key: &String, response: &Arc<CachedResponse>| -> u32 {
            (response.body.len() as u32).saturating_add(200)
        })
        .time_to_live(Duration::from_secs(tuning.cache_ttl_secs))
        .build();

    let stream_cache = Cache::builder()
        .max_capacity(tuning.stream_cache_capacity_bytes)
        .weigher(|_key: &String, response: &Arc<CachedResponse>| -> u32 {
            (response.body.len() as u32).saturating_add(256)
        })
        .time_to_live(Duration::from_secs(tuning.cache_ttl_secs))
        .build();

    let stream_fills = Cache::builder()
        .max_capacity(20_000)
        .time_to_idle(Duration::from_secs(10 * 60))
        .build();

    let folio_cache = Cache::builder()
        .max_capacity((tuning.cache_capacity_bytes / 2).max(64 * 1024 * 1024))
        .weigher(
            |_key: &String, response: &Arc<state::FolioCachedResponse>| -> u32 {
                (response.body.len() as u32).saturating_add(512)
            },
        )
        .time_to_live(Duration::from_secs(tuning.cache_ttl_secs))
        .build();

    let asset_client = Client::builder()
        .user_agent(BROWSER_USER_AGENT)
        .dns_resolver(Arc::new(safe_dns::PublicDnsResolver))
        .redirect(public_redirect_policy())
        .pool_idle_timeout(Duration::from_secs(tuning.pool_idle_timeout_secs))
        .pool_max_idle_per_host(tuning.pool_idle_per_host_asset)
        .tcp_nodelay(true)
        .tcp_keepalive(Duration::from_secs(60))
        .read_timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(10))
        .http2_keep_alive_interval(Duration::from_secs(15))
        .http2_keep_alive_timeout(Duration::from_secs(20))
        .build()?;

    let html_client = Client::builder()
        .user_agent(BROWSER_USER_AGENT)
        .dns_resolver(Arc::new(safe_dns::PublicDnsResolver))
        .redirect(public_redirect_policy())
        .pool_idle_timeout(Duration::from_secs(tuning.pool_idle_timeout_secs))
        .pool_max_idle_per_host(tuning.pool_idle_per_host_html)
        .tcp_nodelay(true)
        .tcp_keepalive(Duration::from_secs(60))
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(10))
        .http2_keep_alive_interval(Duration::from_secs(15))
        .http2_keep_alive_timeout(Duration::from_secs(20))
        .build()?;

    let raw_client = Client::builder()
        .user_agent(BROWSER_USER_AGENT)
        .redirect(Policy::none())
        .dns_resolver(Arc::new(safe_dns::PublicDnsResolver))
        .pool_idle_timeout(Duration::from_secs(tuning.pool_idle_timeout_secs))
        .pool_max_idle_per_host(tuning.pool_idle_per_host_asset)
        .tcp_nodelay(true)
        .tcp_keepalive(Duration::from_secs(60))
        .read_timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(10))
        .http2_keep_alive_interval(Duration::from_secs(15))
        .http2_keep_alive_timeout(Duration::from_secs(20))
        .build()?;

    let patterns = [
        "google-analytics.com",
        "googletagmanager.com",
        "doubleclick.net",
        "adsbygoogle",
        "js.rev.iq",
        "motorsnag.com",
        "monetag",
        "netpub",
    ];
    let blocklist_matcher = Arc::new(AhoCorasick::new(patterns)?);

    let request_permit = AdaptiveGate::new(
        tuning.request_permits_min,
        tuning.request_permits,
        tuning.request_permits_max,
    );
    let stream_upstream_permit = AdaptiveGate::new(
        tuning.stream_upstream_permits_min,
        tuning.stream_upstream_permits,
        tuning.stream_upstream_permits_max,
    );
    let html_rewrite_permit = AdaptiveGate::new(
        tuning.html_rewrite_permits_min,
        tuning.html_rewrite_permits,
        tuning.html_rewrite_permits_max,
    );

    spawn_rebalancer(
        vec![
            CapacityTarget::new(
                request_permit.clone(),
                tuning.ram_cache_limit as u64,
                Workload::Io,
            ),
            CapacityTarget::new(
                stream_upstream_permit.clone(),
                tuning.ram_cache_limit as u64,
                Workload::Io,
            ),
            CapacityTarget::new(
                html_rewrite_permit.clone(),
                (16 * 1024 * 1024) as u64,
                Workload::Cpu,
            ),
        ],
        Duration::from_secs(2),
    );

    let state = Arc::new(AppState {
        html_client,
        asset_client,
        raw_client,
        cache,
        stream_cache,
        stream_fills,
        folio_cache,
        folio_metrics: FolioMetrics::default(),
        blocklist_matcher,
        caching_inflight: DashMap::new(),
        coalesce: DashMap::new(),
        request_permit,
        stream_upstream_permit,
        html_rewrite_permit,
        max_cache_entry_size: tuning.max_cache_entry_size,
        disk_cache_max_age_secs: tuning.disk_max_age_secs,
        folio_cache_max_entry_size: tuning.max_cache_entry_size.min(8 * 1024 * 1024),
        folio_cache_max_ttl_secs: tuning.cache_ttl_secs,
        stream_max_entry_size: tuning.stream_max_entry_size,
        ram_cache_limit: tuning.ram_cache_limit,
        channel_buffer: tuning.channel_buffer,
    });

    let port = std::env::var("MOCHI_PORT").unwrap_or_else(|_| "4002".to_string());
    let port = port.parse::<u16>().unwrap_or(4002);
    let host = std::env::var("MOCHI_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
    let host = host
        .parse::<std::net::IpAddr>()
        .map_err(|_| "invalid mochi bind address... /ᐠ - ˕ -マ")?;
    let addr = SocketAddr::from((host, port));
    tracing::info!("mochi listening on {}{}", addr, POSITIVE);

    tokio::spawn(cache::disk_cache_cleanup_task(
        tuning.disk_cache_bytes,
        tuning.disk_max_age_secs,
        tuning.disk_cleanup_interval_secs,
    ));

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);
    let compression_predicate = DefaultPredicate::new()
        .and(NotForContentType::const_new("video/"))
        .and(NotForContentType::const_new("audio/"))
        .and(
            |status: StatusCode,
             _version: Version,
             headers: &HeaderMap,
             _extensions: &Extensions| {
                status != StatusCode::PARTIAL_CONTENT && !headers.contains_key(CONTENT_RANGE)
            },
        );

    let app = Router::new()
        .route("/health", axum::routing::get(|| async { "oki" }))
        .route("/metrics", axum::routing::get(proxy::metrics_handler))
        .route(
            &format!("{}capabilities", folio::PREFIX),
            axum::routing::get(folio::capabilities_handler),
        )
        .route(
            &format!("{}metrics", folio::PREFIX),
            axum::routing::get(folio::metrics_handler),
        )
        .route(
            &format!("{}*target", folio::REQUEST_PREFIX),
            any(folio::request_handler),
        )
        .route(
            "/stream/metrics",
            axum::routing::get(stream::stream_metrics_handler),
        )
        .route(
            "/stream/info",
            axum::routing::get({
                let state = state.clone();
                move |method: axum::http::Method,
                      uri: axum::http::Uri,
                      headers: axum::http::HeaderMap| {
                    let state = state.clone();
                    async move { stream::stream_info_handler(state, method, uri, headers).await }
                }
            }),
        )
        .route(
            "/stream/*path",
            axum::routing::any({
                let state = state.clone();
                move |method: axum::http::Method,
                      uri: axum::http::Uri,
                      headers: axum::http::HeaderMap| {
                    let state = state.clone();
                    async move { stream::stream_handler(state, method, uri, headers).await }
                }
            }),
        )
        .route(
            &format!("{}*key", constants::MOCHI_RAW_PREFIX),
            any(proxy::raw_proxy_handler),
        )
        .route(
            &format!("{}*key", constants::MOCHI_PREFIX),
            any(proxy::proxy_handler),
        )
        .route("/", any(proxy::proxy_handler))
        .route("/*path", any(proxy::proxy_handler))
        .fallback(any(proxy::proxy_handler))
        .layer(CompressionLayer::new().compress_when(compression_predicate))
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .tcp_nodelay(true)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("shutting down...");
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod message_tests {
    use super::{negative_message, positive_message};

    #[test]
    fn formats_runtime_messages_once() {
        assert_eq!(
            negative_message("request failed"),
            "request failed... /ᐠ - ˕ -マ"
        );
        assert_eq!(
            negative_message("request failed... /ᐠ - ˕ -マ"),
            "request failed... /ᐠ - ˕ -マ"
        );
        assert_eq!(positive_message("ready"), "ready!! (˵◝ ⩊  ◜˵マ");
    }
}
