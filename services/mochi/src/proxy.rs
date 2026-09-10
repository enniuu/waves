use crate::cache::{get_cache_path, load_from_disk, write_cache_header, write_to_disk};
use crate::constants;
use crate::encoding::decode_mochi_url;
use crate::helpers::{
    fix_game_content_type, get_cdn_cache_control, is_blacklisted_header, is_blacklisted_res_header,
    is_likely_static_asset_fast,
};
use crate::rewrite::{rewrite_css_urls, rewrite_html};
use crate::safe_dns::{validate_public_target, validate_public_target_dns};
use crate::state::{AppState, CachedResponse};
use crate::websocket::handle_socket;
use crate::{negative_message, NEGATIVE};
use axum::{
    body::Body,
    extract::{ws::WebSocketUpgrade, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    Json,
};
use base64::Engine as _;
use bytes::Bytes;
use dashmap::mapref::entry::Entry;
use futures_util::StreamExt;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, OnceLock,
};
use std::time::Duration;
use tokio::fs::{self, File};
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::sync::{broadcast, mpsc};
use tokio::time::sleep;
use tokio_stream::wrappers::ReceiverStream;
use tracing::{debug, error, warn};
use url::Url;

static UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
static SEC_CH_UA: &str =
    "\"Not-A.Brand\";v=\"99\", \"Chromium\";v=\"124\", \"Google Chrome\";v=\"124\"";
static MOCHI_UPSTREAM_META_HEADER: &str = "x-mochi-upstream-meta";
const MAX_COVER_BODY_SIZE: usize = 5 * 1024 * 1024;
const MAX_UPSTREAM_ATTEMPTS: usize = 3;
const MAX_UPSTREAM_ERROR_BODY_SIZE: usize = 16 * 1024;
const MAX_HTML_BODY_SIZE: usize = 16 * 1024 * 1024;
const MAX_CSS_BODY_SIZE: usize = 4 * 1024 * 1024;

#[derive(Default)]
struct ProxyMetrics {
    requests: AtomicU64,
    raw_requests: AtomicU64,
    cache_hits: AtomicU64,
    disk_cache_hits: AtomicU64,
    coalesced_requests: AtomicU64,
    upstream_requests: AtomicU64,
    upstream_retries: AtomicU64,
    upstream_errors: AtomicU64,
    network_errors: AtomicU64,
    temporary_source_errors: AtomicU64,
    unavailable_source_errors: AtomicU64,
    implementation_errors: AtomicU64,
    html_rewrites: AtomicU64,
}

static PROXY_METRICS: OnceLock<ProxyMetrics> = OnceLock::new();

fn proxy_metrics() -> &'static ProxyMetrics {
    PROXY_METRICS.get_or_init(ProxyMetrics::default)
}

#[derive(serde::Serialize)]
struct ProxyMetricsSnapshot {
    requests: u64,
    raw_requests: u64,
    cache_hits: u64,
    disk_cache_hits: u64,
    coalesced_requests: u64,
    upstream_requests: u64,
    upstream_retries: u64,
    upstream_errors: u64,
    network_errors: u64,
    temporary_source_errors: u64,
    unavailable_source_errors: u64,
    implementation_errors: u64,
    html_rewrites: u64,
    capacity: CapacityMetrics,
}

#[derive(serde::Serialize)]
struct CapacityMetrics {
    active: usize,
    limit: usize,
    minimum: usize,
    maximum: usize,
    peak: usize,
    waits: u64,
    rejected: u64,
}

pub async fn metrics_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let metrics = proxy_metrics();
    let capacity = state.request_permit.snapshot();
    Json(ProxyMetricsSnapshot {
        requests: metrics.requests.load(Ordering::Relaxed),
        raw_requests: metrics.raw_requests.load(Ordering::Relaxed),
        cache_hits: metrics.cache_hits.load(Ordering::Relaxed),
        disk_cache_hits: metrics.disk_cache_hits.load(Ordering::Relaxed),
        coalesced_requests: metrics.coalesced_requests.load(Ordering::Relaxed),
        upstream_requests: metrics.upstream_requests.load(Ordering::Relaxed),
        upstream_retries: metrics.upstream_retries.load(Ordering::Relaxed),
        upstream_errors: metrics.upstream_errors.load(Ordering::Relaxed),
        network_errors: metrics.network_errors.load(Ordering::Relaxed),
        temporary_source_errors: metrics.temporary_source_errors.load(Ordering::Relaxed),
        unavailable_source_errors: metrics.unavailable_source_errors.load(Ordering::Relaxed),
        implementation_errors: metrics.implementation_errors.load(Ordering::Relaxed),
        html_rewrites: metrics.html_rewrites.load(Ordering::Relaxed),
        capacity: CapacityMetrics {
            active: capacity.active,
            limit: capacity.limit,
            minimum: capacity.minimum,
            maximum: capacity.maximum,
            peak: capacity.peak,
            waits: capacity.waits,
            rejected: capacity.rejected,
        },
    })
}

fn is_retryable_upstream_status(status: u16) -> bool {
    matches!(status, 408 | 425 | 429) || status >= 500
}

fn is_retryable_upstream_error(error: &reqwest::Error) -> bool {
    error.is_connect() || error.is_timeout() || error.is_request()
}

fn upstream_network_error_response() -> Response {
    proxy_metrics()
        .network_errors
        .fetch_add(1, Ordering::Relaxed);
    let mut headers = HeaderMap::new();
    headers.insert(
        "content-type",
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    headers.insert("cache-control", HeaderValue::from_static("no-store"));
    headers.insert("x-lyra-error-class", HeaderValue::from_static("network"));
    (
        StatusCode::BAD_GATEWAY,
        headers,
        negative_message("the game source could not be reached"),
    )
        .into_response()
}

fn upstream_status_error_response(status: StatusCode) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        "content-type",
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    headers.insert("cache-control", HeaderValue::from_static("no-store"));
    let class = if status.is_server_error()
        || matches!(
            status,
            StatusCode::REQUEST_TIMEOUT | StatusCode::TOO_EARLY | StatusCode::TOO_MANY_REQUESTS
        ) {
        proxy_metrics()
            .temporary_source_errors
            .fetch_add(1, Ordering::Relaxed);
        "temporary-source"
    } else {
        proxy_metrics()
            .unavailable_source_errors
            .fetch_add(1, Ordering::Relaxed);
        "unavailable"
    };
    headers.insert("x-lyra-error-class", HeaderValue::from_static(class));
    (
        status,
        headers,
        negative_message(&format!(
            "the game source returned http {}",
            status.as_u16()
        )),
    )
        .into_response()
}

fn classified_error_response(
    status: StatusCode,
    class: &'static str,
    message: &'static str,
) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        "content-type",
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    headers.insert("cache-control", HeaderValue::from_static("no-store"));
    headers.insert("x-lyra-error-class", HeaderValue::from_static(class));
    (status, headers, negative_message(message)).into_response()
}

fn remove_owned_coalesced_request(
    state: &AppState,
    key: &str,
    owner: &broadcast::Sender<Arc<CachedResponse>>,
) {
    state
        .coalesce
        .remove_if(key, |_, current| current.same_channel(owner));
}

#[derive(serde::Serialize)]
struct RawUpstreamMeta {
    status: u16,
    status_text: String,
    url: String,
    raw_headers: Vec<(String, String)>,
}

fn sanitize_forwarded_cookie(cookie: &str) -> String {
    let mut safe_cookie = String::with_capacity(cookie.len() + 8);
    let mut has_same_site_none = false;
    let mut has_secure = false;

    for (index, raw_attribute) in cookie.split(';').enumerate() {
        let attribute = raw_attribute.trim();
        if attribute.is_empty() {
            continue;
        }

        let (name, value) = attribute
            .split_once('=')
            .map(|(name, value)| (name.trim(), value.trim()))
            .unwrap_or((attribute, ""));

        let normalized = if index > 0 && name.eq_ignore_ascii_case("domain") {
            format!("NoDomain={value}")
        } else if index > 0 && name.eq_ignore_ascii_case("samesite") {
            if value.eq_ignore_ascii_case("none") {
                has_same_site_none = true;
            }
            if value.eq_ignore_ascii_case("strict") {
                "SameSite=Lax".to_string()
            } else {
                attribute.to_string()
            }
        } else {
            if index > 0 && name.eq_ignore_ascii_case("secure") && value.is_empty() {
                has_secure = true;
            }
            attribute.to_string()
        };

        if !safe_cookie.is_empty() {
            safe_cookie.push_str("; ");
        }
        safe_cookie.push_str(&normalized);
    }

    if has_same_site_none && !has_secure {
        safe_cookie.push_str("; Secure");
    }

    safe_cookie
}

fn build_safe_response_headers(res_headers_ref: &HeaderMap, is_likely_asset: bool) -> HeaderMap {
    let mut safe_headers = HeaderMap::with_capacity(res_headers_ref.len());
    for (k, v) in res_headers_ref.iter() {
        let key_str = k.as_str();
        if !is_blacklisted_res_header(key_str) {
            if key_str == "set-cookie" {
                let cookie_str = v.to_str().unwrap_or("");
                let safe_cookie = sanitize_forwarded_cookie(cookie_str);
                safe_headers.append(k, HeaderValue::from_str(&safe_cookie).unwrap_or(v.clone()));
            } else {
                safe_headers.insert(k, v.clone());
            }
        }
    }
    if is_likely_asset {
        if let Some(enc) = res_headers_ref.get("content-encoding") {
            safe_headers.insert("content-encoding", enc.clone());
        }
    }
    safe_headers
}

fn request_allows_shared_cache(headers: &HeaderMap) -> bool {
    if headers.contains_key("authorization") || headers.contains_key("proxy-authorization") {
        return false;
    }

    let Some(cookie_header) = headers.get("cookie").and_then(|value| value.to_str().ok()) else {
        return true;
    };

    cookie_header
        .split(';')
        .map(str::trim)
        .filter(|cookie| !cookie.is_empty())
        .all(|cookie| {
            cookie
                .split_once('=')
                .map(|(name, _)| name.trim() == "mochi_base")
                .unwrap_or(false)
        })
}

fn request_forces_refresh(headers: &HeaderMap) -> bool {
    if headers.contains_key("if-none-match") || headers.contains_key("if-modified-since") {
        return true;
    }
    headers
        .get("cache-control")
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value.split(',').any(|directive| {
                matches!(
                    directive
                        .trim()
                        .split_once('=')
                        .map(|(name, _)| name)
                        .unwrap_or(directive.trim())
                        .to_ascii_lowercase()
                        .as_str(),
                    "no-cache" | "no-store"
                )
            })
        })
        .unwrap_or(false)
}

fn response_allows_shared_cache(headers: &HeaderMap) -> bool {
    if headers.contains_key("set-cookie") {
        return false;
    }

    if headers
        .get("vary")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| !value.trim().is_empty())
    {
        return false;
    }

    headers
        .get("cache-control")
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value.split(',').any(|directive| {
                matches!(
                    directive.trim().to_ascii_lowercase().as_str(),
                    "private" | "no-store" | "no-cache"
                )
            })
        })
        .map(|has_private_directive| !has_private_directive)
        .unwrap_or(true)
}

fn shared_cache_allowed(
    request_headers: &HeaderMap,
    response_headers: &HeaderMap,
    force_refresh: bool,
) -> bool {
    !force_refresh
        && request_allows_shared_cache(request_headers)
        && response_allows_shared_cache(response_headers)
}

fn apply_common_request_headers(
    mut req_builder: reqwest::RequestBuilder,
    headers: &HeaderMap,
    target_url: &Url,
    is_likely_asset: bool,
    is_html_page: bool,
) -> reqwest::RequestBuilder {
    for (k, v) in headers.iter() {
        let key_str = k.as_str();
        if !is_blacklisted_header(key_str)
            && !key_str.starts_with("cf-")
            && !key_str.starts_with("x-")
        {
            if !is_likely_asset && key_str == "accept-encoding" {
                continue;
            }
            req_builder = req_builder.header(k, v);
        }
    }
    req_builder = req_builder.header("User-Agent", UA);
    req_builder = req_builder.header("Sec-Ch-Ua", SEC_CH_UA);
    req_builder = req_builder.header("Sec-Ch-Ua-Mobile", "?0");
    req_builder = req_builder.header("Sec-Ch-Ua-Platform", "\"Windows\"");
    req_builder = req_builder.header("Accept-Language", "en-US,en;q=0.9");

    if is_html_page {
        req_builder = req_builder.header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8");
        req_builder = req_builder.header("Sec-Fetch-Site", "cross-site");
        req_builder = req_builder.header("Sec-Fetch-Mode", "navigate");
        req_builder = req_builder.header("Sec-Fetch-Dest", "document");
        req_builder = req_builder.header("Sec-Fetch-User", "?1");
        req_builder = req_builder.header("Upgrade-Insecure-Requests", "1");
    } else {
        req_builder = req_builder.header("Sec-Fetch-Site", "same-origin");
        req_builder = req_builder.header("Sec-Fetch-Mode", "cors");
        req_builder = req_builder.header("Sec-Fetch-Dest", "empty");
        req_builder = req_builder.header("Priority", "u=1, i");
    }

    let origin = target_url.origin().ascii_serialization();
    req_builder = req_builder.header("Referer", format!("{}/", origin));
    req_builder
}

async fn send_upstream_with_retries(
    client: &reqwest::Client,
    method: &Method,
    target_url: &Url,
    headers: &HeaderMap,
    req_body: &Bytes,
    is_likely_asset: bool,
    is_html_page: bool,
) -> Result<reqwest::Response, reqwest::Error> {
    let mut last_error = None;

    for attempt in 0..MAX_UPSTREAM_ATTEMPTS {
        proxy_metrics()
            .upstream_requests
            .fetch_add(1, Ordering::Relaxed);
        let mut req_builder = client.request(method.clone(), target_url.clone());
        req_builder = apply_common_request_headers(
            req_builder,
            headers,
            target_url,
            is_likely_asset,
            is_html_page,
        );
        req_builder =
            req_builder.timeout(Duration::from_secs(if is_likely_asset { 60 } else { 45 }));

        if !req_body.is_empty() {
            req_builder = req_builder.body(req_body.clone());
        }
        match req_builder.send().await {
            Ok(response) => {
                if attempt + 1 < MAX_UPSTREAM_ATTEMPTS
                    && is_retryable_upstream_status(response.status().as_u16())
                {
                    proxy_metrics()
                        .upstream_retries
                        .fetch_add(1, Ordering::Relaxed);
                    drop(response);
                    sleep(Duration::from_millis(150 * (attempt as u64 + 1))).await;
                    continue;
                }
                return Ok(response);
            }
            Err(error) => {
                let should_retry =
                    attempt + 1 < MAX_UPSTREAM_ATTEMPTS && is_retryable_upstream_error(&error);
                if should_retry {
                    proxy_metrics()
                        .upstream_retries
                        .fetch_add(1, Ordering::Relaxed);
                    sleep(Duration::from_millis(150 * (attempt as u64 + 1))).await;
                }
                last_error = Some(error);
                if !should_retry {
                    break;
                }
            }
        }
    }

    Err(last_error.expect("upstream attempt did not produce a result... /ᐠ - ˕ -マ"))
}

async fn drain_limited_error_body(response: reqwest::Response) -> usize {
    let mut stream = response.bytes_stream();
    let mut total = 0usize;
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                total = total.saturating_add(bytes.len());
                if total >= MAX_UPSTREAM_ERROR_BODY_SIZE {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    total.min(MAX_UPSTREAM_ERROR_BODY_SIZE)
}

async fn read_limited_body(response: reqwest::Response, max_size: usize) -> Result<Bytes, ()> {
    if response
        .content_length()
        .is_some_and(|size| size > max_size as u64)
    {
        return Err(());
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ())?;
        if body.len().saturating_add(chunk.len()) > max_size {
            return Err(());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(body))
}

fn encode_raw_upstream_meta(meta: &RawUpstreamMeta) -> Option<HeaderValue> {
    let json = serde_json::to_vec(meta).ok()?;
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json);
    HeaderValue::from_str(&encoded).ok()
}

fn raw_target_from_uri(uri: &Uri) -> Option<String> {
    let path_and_query = uri.path_and_query().map(|p| p.as_str()).unwrap_or("");
    let prefix_pos = path_and_query.find(constants::MOCHI_RAW_PREFIX)?;
    let raw_target = &path_and_query[prefix_pos + constants::MOCHI_RAW_PREFIX.len()..];
    let decoded = urlencoding::decode(raw_target).ok()?.into_owned();

    if decoded.starts_with("http://") || decoded.starts_with("https://") {
        return Some(decoded);
    }

    decode_mochi_url(&decoded)
}

pub async fn raw_proxy_handler(
    State(state): State<Arc<AppState>>,
    method: Method,
    mut headers: HeaderMap,
    uri: Uri,
    req_body: Bytes,
) -> Response {
    proxy_metrics().raw_requests.fetch_add(1, Ordering::Relaxed);
    if method != Method::GET && method != Method::HEAD {
        return classified_error_response(
            StatusCode::METHOD_NOT_ALLOWED,
            "invalid-request",
            "method not supported",
        );
    }

    let target_url_string = match raw_target_from_uri(&uri) {
        Some(target) => target,
        None => {
            return classified_error_response(
                StatusCode::BAD_REQUEST,
                "invalid-request",
                "invalid raw target",
            )
        }
    };

    if state.blocklist_matcher.is_match(&target_url_string) {
        let meta = RawUpstreamMeta {
            status: StatusCode::OK.as_u16(),
            status_text: "OK".to_string(),
            url: target_url_string,
            raw_headers: vec![(
                "content-type".to_string(),
                "application/javascript".to_string(),
            )],
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            "content-type",
            HeaderValue::from_static("application/javascript"),
        );
        headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));
        headers.insert(
            "access-control-expose-headers",
            HeaderValue::from_static("x-mochi-upstream-meta"),
        );
        if let Some(value) = encode_raw_upstream_meta(&meta) {
            headers.insert(MOCHI_UPSTREAM_META_HEADER, value);
        }
        return (
            StatusCode::OK,
            headers,
            format!("/* {} */", negative_message("request blocked")),
        )
            .into_response();
    }

    let target_url = match Url::parse(&target_url_string) {
        Ok(url) if url.scheme() == "http" || url.scheme() == "https" => url,
        _ => {
            return classified_error_response(
                StatusCode::BAD_REQUEST,
                "invalid-request",
                "invalid upstream url",
            )
        }
    };
    if let Err(reason) = validate_public_target(&target_url) {
        return (StatusCode::FORBIDDEN, negative_message(reason)).into_response();
    }

    for name in [
        "cookie",
        "authorization",
        "proxy-authorization",
        "origin",
        "referer",
    ] {
        headers.remove(name);
    }

    let permit = state.request_permit.acquire().await;

    let is_likely_asset = is_likely_static_asset_fast(&target_url_string);
    let looks_like_html_page =
        target_url_string.ends_with(".html") || target_url_string.ends_with(".htm");
    let upstream_res = match send_upstream_with_retries(
        &state.raw_client,
        &method,
        &target_url,
        &headers,
        &req_body,
        is_likely_asset,
        looks_like_html_page,
    )
    .await
    {
        Ok(res) => res,
        Err(error) => {
            proxy_metrics()
                .upstream_errors
                .fetch_add(1, Ordering::Relaxed);
            error!("raw upstream request failed: {}{}", error, NEGATIVE);
            return upstream_network_error_response();
        }
    };

    let status = upstream_res.status();
    let upstream_url = upstream_res.url().to_string();
    let raw_headers = upstream_res
        .headers()
        .iter()
        .filter_map(|(k, v)| Some((k.as_str().to_string(), v.to_str().ok()?.to_string())))
        .collect::<Vec<_>>();
    let meta = RawUpstreamMeta {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        url: upstream_url,
        raw_headers,
    };

    let mut safe_headers = build_safe_response_headers(upstream_res.headers(), is_likely_asset);
    safe_headers.remove("set-cookie");
    safe_headers.remove("content-length");
    fix_game_content_type(&target_url_string, &mut safe_headers);
    safe_headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    safe_headers.insert(
        "access-control-expose-headers",
        HeaderValue::from_static("x-mochi-upstream-meta"),
    );
    if let Some(value) = encode_raw_upstream_meta(&meta) {
        safe_headers.insert(MOCHI_UPSTREAM_META_HEADER, value);
    } else {
        return classified_error_response(
            StatusCode::BAD_GATEWAY,
            "implementation",
            "failed to encode upstream metadata",
        );
    }

    if method == Method::HEAD
        || status == StatusCode::NO_CONTENT
        || status == StatusCode::NOT_MODIFIED
    {
        return (StatusCode::OK, safe_headers).into_response();
    }

    let stream = upstream_res.bytes_stream().map(move |item| {
        let _permit = &permit;
        item
    });
    (StatusCode::OK, safe_headers, Body::from_stream(stream)).into_response()
}

pub async fn proxy_handler(
    State(state): State<Arc<AppState>>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    ws: Option<WebSocketUpgrade>,
    req_body: Bytes,
) -> Response {
    proxy_metrics().requests.fetch_add(1, Ordering::Relaxed);
    let mut valid_token: Option<String> = None;
    let original_uri = uri.path_and_query().map(|p| p.as_str()).unwrap_or("");
    let path_and_query = uri.path_and_query().map(|p| p.as_str()).unwrap_or("");
    let is_cover_request = path_and_query.contains(constants::COVER_PREFIX);
    let prefix = if is_cover_request {
        constants::COVER_PREFIX
    } else {
        constants::MOCHI_PREFIX
    };
    let prefix_pos = path_and_query.find(prefix).unwrap_or(0);
    let raw_target = &path_and_query[prefix_pos + prefix.len()..];
    let decoded_target_owned = if !raw_target.starts_with("http")
        && !raw_target.starts_with("ws")
        && !raw_target.is_empty()
    {
        let clean = raw_target.trim_end_matches('/');
        let (token, mut remainder) = clean.split_once('/').unwrap_or((clean, ""));

        if remainder.starts_with("!a!") {
            remainder = remainder.trim_start_matches("!a!");
        }

        if let Some(decoded_base) = decode_mochi_url(token) {
            valid_token = Some(token.to_string());

            if remainder.is_empty() {
                decoded_base
            } else {
                let mut base_for_join = decoded_base.clone();
                if !base_for_join.ends_with('/')
                    && !base_for_join
                        .split('?')
                        .next()
                        .unwrap_or("")
                        .split('/')
                        .next_back()
                        .unwrap_or("")
                        .contains('.')
                {
                    base_for_join.push('/');
                }

                match url::Url::parse(&base_for_join) {
                    Ok(base) => base
                        .join(remainder)
                        .map(|u| u.to_string())
                        .unwrap_or_else(|_| {
                            format!("{}/{}", base_for_join.trim_end_matches('/'), remainder)
                        }),
                    Err(_) => {
                        format!("{}/{}", base_for_join.trim_end_matches('/'), remainder)
                    }
                }
            }
        } else {
            let mut fallback_target = raw_target.to_string();

            if let Some(referer) = headers.get("referer").and_then(|v| v.to_str().ok()) {
                if let Some(referer_target) = referer.split(prefix).nth(1) {
                    let referer_clean = referer_target.trim_end_matches('/');
                    let (ref_token, _) =
                        referer_clean.split_once('/').unwrap_or((referer_clean, ""));
                    if let Some(ref_decoded_base) = decode_mochi_url(ref_token) {
                        if let Ok(ref_url) = url::Url::parse(&ref_decoded_base) {
                            if let Ok(resolved) = ref_url.join(original_uri) {
                                fallback_target = resolved.to_string();
                            }
                        }
                    }
                }
            }

            if fallback_target == raw_target {
                if let Some(cookie_hdr) = headers.get("cookie").and_then(|c| c.to_str().ok()) {
                    for cookie in cookie_hdr.split(';') {
                        let cookie = cookie.trim();
                        if let Some(base_token) = cookie.strip_prefix("mochi_base=") {
                            if let Some(ref_decoded_base) = decode_mochi_url(base_token) {
                                if let Ok(ref_url) = Url::parse(&ref_decoded_base) {
                                    if let Ok(resolved) = ref_url.join(original_uri) {
                                        fallback_target = resolved.to_string();
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            fallback_target
        }
    } else {
        raw_target.to_string()
    };
    let target_url_str: &str = &decoded_target_owned;
    debug!("proxying request");

    if let Some(ws) = ws {
        if target_url_str.starts_with("ws/") || headers.contains_key("upgrade") {
            let real_target = if let Some(remaining) = target_url_str.strip_prefix("ws/") {
                if remaining.starts_with("http") {
                    remaining
                        .replace("http://", "ws://")
                        .replace("https://", "wss://")
                } else if remaining.starts_with("wss://") {
                    remaining.to_string()
                } else {
                    let decoded = urlencoding::decode(remaining)
                        .unwrap_or(std::borrow::Cow::Borrowed(remaining));
                    if decoded.starts_with("wss://") || decoded.starts_with("ws://") {
                        decoded.into_owned()
                    } else {
                        target_url_str
                            .replace("ws/", "https://")
                            .replace("http://", "ws://")
                            .replace("https://", "wss://")
                    }
                }
            } else {
                if target_url_str.starts_with("http") {
                    target_url_str
                        .replace("http://", "ws://")
                        .replace("https://", "wss://")
                } else {
                    format!("wss://{}", target_url_str)
                }
            };
            let validation_target = real_target
                .replacen("wss://", "https://", 1)
                .replacen("ws://", "http://", 1);
            let validation_url = match Url::parse(&validation_target) {
                Ok(url) => url,
                Err(_) => {
                    return classified_error_response(
                        StatusCode::BAD_REQUEST,
                        "invalid-request",
                        "invalid websocket target",
                    )
                }
            };
            if let Err(reason) = validate_public_target_dns(&validation_url).await {
                warn!("blocked websocket target: {}{}", reason, NEGATIVE);
                return classified_error_response(
                    StatusCode::FORBIDDEN,
                    "invalid-request",
                    "game source target is not allowed",
                );
            }

            let mut protocols = Vec::new();
            if let Some(p) = headers.get("sec-websocket-protocol") {
                if let Ok(s) = p.to_str() {
                    protocols = s.split(',').map(|x| x.trim().to_string()).collect();
                }
            }
            let ws = if !protocols.is_empty() {
                ws.protocols(protocols)
            } else {
                ws
            };

            let Some(permit) = state
                .request_permit
                .acquire_timeout(Duration::from_secs(5))
                .await
            else {
                return classified_error_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "infrastructure",
                    "proxy capacity is temporarily exhausted",
                );
            };
            let headers_clone = headers.clone();
            return ws.on_upgrade(move |socket| async move {
                let _permit = permit;
                handle_socket(socket, real_target, headers_clone).await;
            });
        }
    }

    let target_url_string = if !target_url_str.starts_with("http") {
        format!("https://{}", target_url_str)
    } else {
        target_url_str.to_string()
    };
    let target_url = match Url::parse(&target_url_string) {
        Ok(url) => url,
        Err(_) => {
            return classified_error_response(
                StatusCode::BAD_REQUEST,
                "invalid-request",
                "invalid upstream url",
            )
        }
    };
    if let Err(reason) = validate_public_target(&target_url) {
        warn!("blocked proxy target: {}{}", reason, NEGATIVE);
        return classified_error_response(
            StatusCode::FORBIDDEN,
            "invalid-request",
            "game source target is not allowed",
        );
    }

    let force_refresh = request_forces_refresh(&headers);

    let request_cache_allowed = request_allows_shared_cache(&headers);

    if method == Method::GET && !force_refresh && request_cache_allowed {
        if let Some(cached) = state.cache.get(target_url_str).await {
            proxy_metrics().cache_hits.fetch_add(1, Ordering::Relaxed);
            let mut res_headers = cached.headers.clone();
            res_headers.insert("X-Cache", HeaderValue::from_static("HIT"));

            fix_game_content_type(target_url_str, &mut res_headers);
            let status = StatusCode::from_u16(cached.status).unwrap_or(StatusCode::OK);
            return (status, res_headers, cached.body.clone()).into_response();
        }
    }

    if state.blocklist_matcher.is_match(&target_url_string) {
        let mut headers = HeaderMap::new();
        headers.insert(
            "Content-Type",
            HeaderValue::from_static("application/javascript"),
        );
        return (
            StatusCode::OK,
            headers,
            format!("/* {} */", negative_message("request blocked")),
        )
            .into_response();
    }

    let is_likely_asset = is_likely_static_asset_fast(&target_url_string);
    let looks_like_html_page =
        target_url_string.ends_with(".html") || target_url_string.ends_with(".htm");

    if method == Method::GET && is_cover_request {
        let mut response = fetch_and_cache(
            &state,
            &target_url,
            &target_url_string,
            target_url_str,
            &headers,
            &req_body,
            Some(MAX_COVER_BODY_SIZE),
        )
        .await
        .unwrap_or_else(|error| *error);
        if !response.status().is_success() {
            response.headers_mut().insert(
                "Cache-Control",
                HeaderValue::from_static("no-store, must-revalidate"),
            );
        }
        return response;
    }

    if method == Method::GET && is_likely_asset {
        return fetch_and_cache(
            &state,
            &target_url,
            &target_url_string,
            target_url_str,
            &headers,
            &req_body,
            None,
        )
        .await
        .unwrap_or_else(|error| *error);
    }

    let Some(request_permit) = state
        .request_permit
        .acquire_timeout(Duration::from_secs(5))
        .await
    else {
        return classified_error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "infrastructure",
            "proxy capacity is temporarily exhausted",
        );
    };

    let client = if is_likely_asset {
        &state.asset_client
    } else {
        &state.html_client
    };

    let upstream_res = match send_upstream_with_retries(
        client,
        &method,
        &target_url,
        &headers,
        &req_body,
        is_likely_asset,
        looks_like_html_page,
    )
    .await
    {
        Ok(res) => res,
        Err(error) => {
            proxy_metrics()
                .upstream_errors
                .fetch_add(1, Ordering::Relaxed);
            error!("upstream request failed: {}{}", error, NEGATIVE);
            return upstream_network_error_response();
        }
    };

    let status = upstream_res.status();
    debug!("upstream response status: {}", status);

    if status == StatusCode::NOT_MODIFIED {
        return not_modified_response(upstream_res.headers());
    }

    if status.is_redirection() {
        return classified_error_response(
            StatusCode::BAD_GATEWAY,
            "unavailable",
            "game source redirected too many times",
        );
    }

    if !status.is_success() {
        let body_bytes = drain_limited_error_body(upstream_res).await;
        proxy_metrics()
            .upstream_errors
            .fetch_add(1, Ordering::Relaxed);
        error!(
            "upstream returned non-success status {} (read {} error bytes){}",
            status, body_bytes, NEGATIVE
        );
        return upstream_status_error_response(status);
    }

    let res_headers_ref = upstream_res.headers();

    let mut safe_headers = build_safe_response_headers(res_headers_ref, is_likely_asset);

    fix_game_content_type(&target_url_string, &mut safe_headers);
    safe_headers.insert("Access-Control-Allow-Origin", HeaderValue::from_static("*"));
    safe_headers.insert(
        "Cross-Origin-Opener-Policy",
        HeaderValue::from_static("same-origin"),
    );
    safe_headers.insert(
        "Cross-Origin-Embedder-Policy",
        HeaderValue::from_static("require-corp"),
    );
    safe_headers.insert(
        "Cross-Origin-Resource-Policy",
        HeaderValue::from_static("cross-origin"),
    );
    safe_headers.insert("X-Cache", HeaderValue::from_static("MISS"));

    let content_type = safe_headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let content_type_lower = content_type.to_ascii_lowercase();
    let is_html = (content_type_lower.contains("text/html")
        || (content_type == "application/octet-stream"
            && (target_url_str.ends_with(".html") || target_url_str.ends_with(".htm")))
        || (content_type == "text/plain"
            && (target_url_str.ends_with(".html") || target_url_str.ends_with(".htm"))))
        && !target_url_str.ends_with(".swf")
        && !target_url_str.ends_with(".wasm");

    if is_html && status.is_success() && !is_likely_asset && method == Method::GET {
        safe_headers.remove("content-length");
        safe_headers.remove("content-encoding");

        if let Some(token) = &valid_token {
            let cookie_val = format!("mochi_base={}; Path=/; SameSite=Lax", token);
            safe_headers.append("set-cookie", HeaderValue::from_str(&cookie_val).unwrap());
        }

        let html_permit = match state
            .html_rewrite_permit
            .acquire_timeout(Duration::from_secs(5))
            .await
        {
            Some(permit) => permit,
            None => {
                return classified_error_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "infrastructure",
                    "proxy capacity is temporarily exhausted",
                );
            }
        };

        let effective_url = upstream_res.url().clone();

        let full_body = match read_limited_body(upstream_res, MAX_HTML_BODY_SIZE).await {
            Ok(body) => body,
            Err(_) => {
                return classified_error_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "upstream-data",
                    "game page is too large to process",
                );
            }
        };

        let effective_url_clone = effective_url.clone();

        let body_vec = match tokio::task::spawn_blocking(move || {
            let _permit = html_permit;
            let base_url_str = effective_url_clone.to_string();
            rewrite_html(&full_body, &effective_url_clone, &base_url_str)
        })
        .await
        {
            Ok(body) => body,
            Err(error) => {
                proxy_metrics()
                    .implementation_errors
                    .fetch_add(1, Ordering::Relaxed);
                error!("html rewrite task failed: {}{}", error, NEGATIVE);
                return classified_error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "implementation",
                    "game page processing failed",
                );
            }
        };

        proxy_metrics()
            .html_rewrites
            .fetch_add(1, Ordering::Relaxed);

        let body_bytes = Bytes::from(body_vec);

        if shared_cache_allowed(&headers, &safe_headers, force_refresh)
            && !body_bytes.is_empty()
            && body_bytes.len() <= state.max_cache_entry_size
        {
            let status_u16 = status.as_u16();
            let cache_key = target_url_str.to_string();
            let safe_headers_for_cache = safe_headers.clone();
            let cached_body = body_bytes.clone();

            let cached = Arc::new(CachedResponse {
                status: status_u16,
                headers: safe_headers_for_cache,
                body: cached_body.clone(),
            });

            state.cache.insert(cache_key.clone(), cached.clone()).await;

            let headers_for_disk = safe_headers.clone();
            let body_for_disk = cached_body;
            tokio::spawn(async move {
                write_to_disk(&cache_key, status_u16, &headers_for_disk, &body_for_disk).await;
            });
        }

        return (status, safe_headers, Body::from(body_bytes)).into_response();
    }

    let is_image = content_type.starts_with("image/");
    let is_json = content_type.contains("json");
    let is_favicon_heuristic = target_url_str.contains("favicons?");
    let is_css = content_type.contains("text/css");
    let is_js = content_type.contains("javascript");
    let is_font = content_type.starts_with("font/") || content_type.contains("font");
    let is_wasm = content_type.contains("wasm");
    let should_cache = (is_likely_asset
        || is_image
        || is_json
        || is_favicon_heuristic
        || is_css
        || is_js
        || is_font
        || is_wasm)
        && status == StatusCode::OK
        && method == Method::GET
        && request_cache_allowed
        && !force_refresh
        && response_allows_shared_cache(&safe_headers)
        && !headers.contains_key("upgrade")
        && !headers.contains_key("range");

    if is_css && status.is_success() && method == Method::GET {
        safe_headers.remove("content-length");
        let full_body = match read_limited_body(upstream_res, MAX_CSS_BODY_SIZE).await {
            Ok(body) => body,
            Err(_) => {
                return classified_error_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "upstream-data",
                    "stylesheet is too large to process",
                );
            }
        };
        let css_str = String::from_utf8_lossy(&full_body);
        let rewritten_css = rewrite_css_urls(&css_str, &target_url);
        let rewritten_bytes = Bytes::from(rewritten_css.into_bytes());

        if !should_cache {
            safe_headers.insert(
                "Cache-Control",
                HeaderValue::from_static(get_cdn_cache_control(&target_url_string)),
            );
        } else {
            let cc = get_cdn_cache_control(&target_url_string);
            safe_headers.insert("Cache-Control", HeaderValue::from_static(cc));
        }

        if should_cache && rewritten_bytes.len() <= state.max_cache_entry_size {
            let cached = Arc::new(CachedResponse {
                status: status.as_u16(),
                headers: safe_headers.clone(),
                body: rewritten_bytes.clone(),
            });
            state.cache.insert(target_url_str.to_string(), cached).await;
        }

        return (status, safe_headers, Body::from(rewritten_bytes)).into_response();
    }

    if should_cache {
        let (sender_tx, sender_rx) =
            mpsc::channel::<Result<Bytes, std::io::Error>>(state.channel_buffer);
        let target_url_str_owned = target_url_str.to_string();
        let max_entry = state.max_cache_entry_size;
        let state_clone = state.clone();
        let status_u16 = status.as_u16();
        let cc = get_cdn_cache_control(&target_url_string);
        safe_headers.insert("Cache-Control", HeaderValue::from_static(cc));
        let safe_headers_clone = safe_headers.clone();

        tokio::spawn(async move {
            let _request_permit = request_permit;
            let mut stream = upstream_res.bytes_stream();
            let mut accumulator = Vec::new();
            let mut total_size = 0usize;
            let mut aborted = false;

            while let Some(item) = stream.next().await {
                match item {
                    Ok(chunk) => {
                        total_size += chunk.len();
                        if total_size < max_entry {
                            accumulator.extend_from_slice(&chunk);
                        }
                        if sender_tx.send(Ok(chunk)).await.is_err() {
                            aborted = true;
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = sender_tx
                            .send(Err(std::io::Error::other(e.to_string())))
                            .await;
                        aborted = true;
                        break;
                    }
                }
            }

            if !aborted && total_size < max_entry && total_size > 0 {
                let body_bytes = Bytes::from(accumulator);
                let cached = Arc::new(CachedResponse {
                    status: status_u16,
                    headers: safe_headers_clone,
                    body: body_bytes,
                });
                state_clone.cache.insert(target_url_str_owned, cached).await;
            }
        });

        let stream_body = Body::from_stream(ReceiverStream::new(sender_rx));
        return (status, safe_headers, stream_body).into_response();
    }

    let stream = upstream_res.bytes_stream().map(move |item| {
        let _permit = &request_permit;
        item
    });
    let stream = Body::from_stream(stream);
    (status, safe_headers, stream).into_response()
}

fn not_modified_response(headers: &HeaderMap) -> Response {
    (StatusCode::NOT_MODIFIED, build_safe_response_headers(headers, false)).into_response()
}

async fn fetch_and_cache(
    state: &Arc<AppState>,
    target_url: &Url,
    target_url_string: &str,
    target_url_str: &str,
    headers: &HeaderMap,
    req_body: &Bytes,
    max_body_size: Option<usize>,
) -> Result<Response, Box<Response>> {
    let force_refresh = request_forces_refresh(headers);
    let request_cache_allowed = request_allows_shared_cache(headers);

    let has_range = headers.contains_key("range");

    if request_cache_allowed && !force_refresh && !has_range {
        if let Some(cached) = state.cache.get(target_url_str).await {
            let mut res_headers = cached.headers.clone();
            res_headers.insert("X-Cache", HeaderValue::from_static("HIT"));
            fix_game_content_type(target_url_string, &mut res_headers);
            let status = StatusCode::from_u16(cached.status).unwrap_or(StatusCode::OK);
            return Ok((status, res_headers, cached.body.clone()).into_response());
        }
    }

    if request_cache_allowed && !force_refresh && !has_range {
        if let Some(disk_response) = load_from_disk(
            target_url_str,
            state.max_cache_entry_size,
            state.disk_cache_max_age_secs,
        )
        .await
        {
            proxy_metrics()
                .disk_cache_hits
                .fetch_add(1, Ordering::Relaxed);
            debug!("disk cache hit");
            let (mut response, _) = disk_response;
            fix_game_content_type(target_url_string, response.headers_mut());
            return Ok(response);
        }
    }

    let (coalesce_tx_clone, coalesce_receiver) =
        if request_cache_allowed && !force_refresh && !has_range {
            match state.coalesce.entry(target_url_str.to_string()) {
                Entry::Occupied(entry) => {
                    proxy_metrics()
                        .coalesced_requests
                        .fetch_add(1, Ordering::Relaxed);
                    (None, Some(entry.get().subscribe()))
                }
                Entry::Vacant(entry) => {
                    let (coalesce_tx, _) = broadcast::channel::<Arc<CachedResponse>>(1);
                    entry.insert(coalesce_tx.clone());
                    (Some(coalesce_tx), None)
                }
            }
        } else {
            (None, None)
        };

    if let Some(mut rx) = coalesce_receiver {
        debug!("coalescing request");

        match tokio::time::timeout(Duration::from_secs(30), rx.recv()).await {
            Ok(Ok(cached)) => {
                let mut res_headers = cached.headers.clone();
                res_headers.insert("X-Cache", HeaderValue::from_static("COALESCED"));
                fix_game_content_type(target_url_string, &mut res_headers);
                let status = StatusCode::from_u16(cached.status).unwrap_or(StatusCode::OK);
                return Ok((status, res_headers, cached.body.clone()).into_response());
            }

            Ok(Err(_)) => {}
            _ => {
                return Err(Box::new(classified_error_response(
                    StatusCode::GATEWAY_TIMEOUT,
                    "temporary-source",
                    "an identical upstream request is still in progress",
                )));
            }
        }
    }
    let permit = state.request_permit.acquire().await;

    let client = &state.asset_client;
    let upstream_res = match send_upstream_with_retries(
        client,
        &Method::GET,
        target_url,
        headers,
        req_body,
        true,
        false,
    )
    .await
    {
        Ok(res) => res,
        Err(error) => {
            error!(
                "upstream error for {}: {}{}",
                target_url_str, error, NEGATIVE
            );
            proxy_metrics()
                .upstream_errors
                .fetch_add(1, Ordering::Relaxed);
            if let Some(owner) = coalesce_tx_clone.as_ref() {
                remove_owned_coalesced_request(state, target_url_str, owner);
            }
            return Err(Box::new(upstream_network_error_response()));
        }
    };

    let status = upstream_res.status();

    if status == StatusCode::NOT_MODIFIED {
        if let Some(owner) = coalesce_tx_clone.as_ref() {
            remove_owned_coalesced_request(state, target_url_str, owner);
        }
        return Ok(not_modified_response(upstream_res.headers()));
    }

    if max_body_size.is_some_and(|max_size| {
        upstream_res
            .content_length()
            .is_some_and(|size| size > max_size as u64)
    }) {
        if let Some(owner) = coalesce_tx_clone.as_ref() {
            remove_owned_coalesced_request(state, target_url_str, owner);
        }
        return Err(Box::new(classified_error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "invalid-request",
            "asset is too large",
        )));
    }

    if status.is_redirection() {
        if let Some(owner) = coalesce_tx_clone.as_ref() {
            remove_owned_coalesced_request(state, target_url_str, owner);
        }
        return Err(Box::new(classified_error_response(
            StatusCode::BAD_GATEWAY,
            "unavailable",
            "game source redirected too many times",
        )));
    }

    if !status.is_success() {
        let body_bytes = drain_limited_error_body(upstream_res).await;
        proxy_metrics()
            .upstream_errors
            .fetch_add(1, Ordering::Relaxed);
        if let Some(owner) = coalesce_tx_clone.as_ref() {
            remove_owned_coalesced_request(state, target_url_str, owner);
        }
        error!(
            "asset source returned non-success status {} for {} (read {} error bytes){}",
            status, target_url, body_bytes, NEGATIVE
        );
        return Err(Box::new(upstream_status_error_response(status)));
    }

    let res_headers_ref = upstream_res.headers();
    let upstream_allows_shared_cache = response_allows_shared_cache(res_headers_ref);

    let mut safe_headers = build_safe_response_headers(res_headers_ref, true);

    if status.is_success() {
        let is_unstable = target_url_str.contains("/main/") || target_url_str.contains("/master/");
        let cc_value = if is_unstable {
            "public, max-age=300, stale-while-revalidate=60"
        } else {
            get_cdn_cache_control(target_url_string)
        };
        safe_headers.insert("Cache-Control", HeaderValue::from_static(cc_value));
    }

    fix_game_content_type(target_url_string, &mut safe_headers);
    safe_headers.insert("Access-Control-Allow-Origin", HeaderValue::from_static("*"));
    safe_headers.insert(
        "Cross-Origin-Opener-Policy",
        HeaderValue::from_static("same-origin"),
    );
    safe_headers.insert(
        "Cross-Origin-Embedder-Policy",
        HeaderValue::from_static("require-corp"),
    );
    safe_headers.insert(
        "Cross-Origin-Resource-Policy",
        HeaderValue::from_static("cross-origin"),
    );
    safe_headers.insert("X-Cache", HeaderValue::from_static("MISS"));

    let should_cache = status == StatusCode::OK
        && !force_refresh
        && request_cache_allowed
        && upstream_allows_shared_cache
        && !has_range;

    let actually_cache = should_cache
        && match state.caching_inflight.entry(target_url_str.to_string()) {
            Entry::Occupied(_) => false,
            Entry::Vacant(entry) => {
                entry.insert(());
                true
            }
        };

    if !actually_cache {
        if let Some(owner) = coalesce_tx_clone.as_ref() {
            remove_owned_coalesced_request(state, target_url_str, owner);
        }
    }

    if actually_cache {
        let (sender_tx, sender_rx) =
            mpsc::channel::<Result<Bytes, std::io::Error>>(state.channel_buffer);
        let target_url_str_owned = target_url_str.to_string();
        let ram_limit = state.ram_cache_limit;
        let max_stream_size = max_body_size.unwrap_or(state.max_cache_entry_size);
        let state_clone = state.clone();
        let safe_headers_clone = safe_headers.clone();
        let coalesce_owner = coalesce_tx_clone;

        tokio::spawn(async move {
            let _permit = permit;
            let cache_path = get_cache_path(&target_url_str_owned);
            let temp_path = format!("{}.{}.tmp", cache_path, uuid::Uuid::new_v4());
            let mut disk_write_success = true;

            let mut file = match File::create(&temp_path).await {
                Ok(f) => Some(BufWriter::new(f)),
                Err(e) => {
                    warn!(
                        "failed to create temporary file {}: {}{}",
                        temp_path, e, NEGATIVE
                    );
                    disk_write_success = false;
                    None
                }
            };

            if disk_write_success {
                if let Some(ref mut f) = file {
                    disk_write_success =
                        write_cache_header(f, status.as_u16(), &safe_headers_clone)
                            .await
                            .is_ok();
                }
            }

            if !disk_write_success {
                file = None;
                let _ = fs::remove_file(&temp_path).await;
            }

            let mut stream = upstream_res.bytes_stream();
            let mut accumulator = Vec::new();
            let mut total_size = 0;
            let mut aborted = false;
            let mut is_too_large_for_ram = false;

            while let Some(item) = stream.next().await {
                match item {
                    Ok(chunk) => {
                        let chunk_len = chunk.len();
                        total_size += chunk_len;

                        if total_size > max_stream_size {
                            let _ = sender_tx
                                .send(Err(std::io::Error::new(
                                    std::io::ErrorKind::InvalidData,
                                    "asset is too large... /ᐠ - ˕ -マ",
                                )))
                                .await;
                            aborted = true;
                            break;
                        }

                        if let Some(ref mut f) = file {
                            if f.write_all(&chunk).await.is_err() {
                                file = None;
                                disk_write_success = false;
                                let _ = fs::remove_file(&temp_path).await;
                            }
                        }

                        if !is_too_large_for_ram {
                            if total_size < ram_limit {
                                accumulator.extend_from_slice(&chunk);
                            } else {
                                is_too_large_for_ram = true;
                                accumulator = Vec::new();
                            }
                        }

                        if sender_tx.send(Ok(chunk)).await.is_err() {
                            aborted = true;
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = sender_tx
                            .send(Err(std::io::Error::other(e.to_string())))
                            .await;
                        aborted = true;
                        break;
                    }
                }
            }

            if !aborted && disk_write_success {
                if let Some(mut f) = file.take() {
                    if f.flush().await.is_ok() {
                        drop(f);
                        let _ = fs::rename(&temp_path, &cache_path).await;
                    } else {
                        let _ = fs::remove_file(&temp_path).await;
                    }
                }

                if !is_too_large_for_ram && total_size < ram_limit {
                    let body_bytes = Bytes::from(accumulator);
                    let cached = Arc::new(CachedResponse {
                        status: status.as_u16(),
                        headers: safe_headers_clone,
                        body: body_bytes,
                    });
                    state_clone
                        .cache
                        .insert(target_url_str_owned.clone(), cached.clone())
                        .await;
                    if let Some(coalesce_tx) = coalesce_owner.as_ref() {
                        let _ = coalesce_tx.send(cached);
                    }
                }
            } else {
                let _ = fs::remove_file(&temp_path).await;
            }

            state_clone.caching_inflight.remove(&target_url_str_owned);
            if let Some(owner) = coalesce_owner.as_ref() {
                remove_owned_coalesced_request(&state_clone, &target_url_str_owned, owner);
            }
        });

        let stream_body = Body::from_stream(ReceiverStream::new(sender_rx));
        let response = (status, safe_headers, stream_body).into_response();

        return Ok(response);
    }

    let stream = upstream_res.bytes_stream().map(move |item| {
        let _permit = &permit;
        item
    });
    let stream = Body::from_stream(stream);
    let response = (status, safe_headers, stream).into_response();
    Ok(response)
}
