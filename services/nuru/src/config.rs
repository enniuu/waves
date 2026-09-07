use std::{collections::HashMap, net::IpAddr, ops::RangeInclusive, path::PathBuf};

use crate::tuning;

use clap::{Parser, ValueEnum};
use lazy_static::lazy_static;
use log::LevelFilter;
use regex::RegexSet;
use serde::{Deserialize, Serialize};
use wisp_mux::{
    extensions::{
        cert::{CertAuthProtocolExtension, CertAuthProtocolExtensionBuilder},
        motd::MotdProtocolExtensionBuilder,
        password::{PasswordProtocolExtension, PasswordProtocolExtensionBuilder},
        udp::UdpProtocolExtensionBuilder,
        AnyProtocolExtensionBuilder,
    },
    WispV2Handshake,
};

use crate::{handle::wisp::utils::get_certificates_from_paths, CLI, CONFIG, RESOLVER};

pub const VERSION_STRING: &str = concat!(
    "git ",
    env!("VERGEN_GIT_SHA"),
    ", dirty ",
    env!("VERGEN_GIT_DIRTY"),
    ", compiled with rustc ",
    env!("VERGEN_RUSTC_SEMVER"),
    " on ",
    env!("VERGEN_RUSTC_HOST_TRIPLE")
);

#[derive(Serialize, Deserialize, Default, Debug, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum SocketType {
    #[default]
    Tcp,
    TlsTcp,
    Unix,
    TlsUnix,
    File,
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "lowercase")]
pub enum SocketTransport {
    #[default]
    WebSocket,
    LengthDelimitedLe,
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeFlavor {
    SingleThread,
    #[default]
    MultiThread,
    #[cfg(tokio_unstable)]
    MultiThreadAlt,
    ThreadPerCore,
}

impl RuntimeFlavor {
    pub fn is_thread_per_core(&self) -> bool {
        matches!(self, Self::ThreadPerCore)
    }
}

pub type BindAddr = (SocketType, String);

#[derive(Serialize, Deserialize, Debug)]
#[serde(untagged)]
pub enum StatsEndpoint {
    SameServer(String),
    SeparateServer(BindAddr),
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    pub bind: BindAddr,
    pub transport: SocketTransport,
    pub resolve_ipv6: bool,
    pub tcp_nodelay: bool,
    pub file_raw_mode: bool,
    pub tls_keypair: Option<[PathBuf; 2]>,
    pub stats_endpoint: Option<StatsEndpoint>,
    pub use_real_ip_headers: bool,
    pub websocket_origin_scheme: Option<String>,
    pub non_ws_response: String,
    pub max_message_size: usize,
    pub log_level: LevelFilter,
    pub runtime: RuntimeFlavor,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProtocolExtension {
    Udp,
    Motd,
    Wispnet,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProtocolExtensionAuth {
    Password,
    Certificate,
}

#[doc(hidden)]
fn default_motd() -> String {
    format!("nuru ({VERSION_STRING})")
}

#[doc(hidden)]
fn is_default_motd(str: &String) -> bool {
    *str == default_motd()
}

#[doc(hidden)]
fn wisp_buffer_size() -> u32 {
    tuning::wisp_buffer_size()
}

#[doc(hidden)]
fn default_ping_interval_secs() -> u64 {
    30
}

#[doc(hidden)]
fn default_resolve_cache_ttl_secs() -> u64 {
    10
}

#[doc(hidden)]
fn default_resolve_cache_max_entries() -> usize {
    tuning::resolve_cache_max() as usize
}

#[doc(hidden)]
fn default_resolve_timeout_ms() -> u64 {
    6000
}

#[doc(hidden)]
fn default_connect_timeout_ms() -> u64 {
    8000
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct WispConfig {
    pub allow_wsproxy: bool,
    #[serde(default = "wisp_buffer_size")]
    pub buffer_size: u32,
    pub prefix: String,
    #[serde(default = "default_ping_interval_secs")]
    pub ping_interval_secs: u64,
    #[serde(default = "default_resolve_cache_ttl_secs")]
    pub resolve_cache_ttl_secs: u64,
    #[serde(default = "default_resolve_cache_max_entries")]
    pub resolve_cache_max_entries: usize,
    pub wisp_v2: bool,
    pub extensions: Vec<ProtocolExtension>,
    pub auth_extension: Option<ProtocolExtensionAuth>,

    #[cfg(feature = "speed-limit")]
    pub read_limit: f64,
    #[cfg(feature = "speed-limit")]
    pub write_limit: f64,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub password_extension_users: HashMap<String, String>,
    pub password_extension_required: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub certificate_extension_keys: Vec<PathBuf>,
    pub certificate_extension_required: bool,
    #[serde(skip_serializing_if = "is_default_motd")]
    pub motd_extension: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct StreamConfig {
    pub tcp_nodelay: bool,
    pub buffer_size: usize,
    #[serde(default = "default_resolve_timeout_ms")]
    pub resolve_timeout_ms: u64,
    #[serde(default = "default_connect_timeout_ms")]
    pub connect_timeout_ms: u64,
    pub allow_udp: bool,
    pub allow_wsproxy_udp: bool,
    #[cfg(feature = "twisp")]
    pub allow_twisp: bool,
    pub dns_servers: Vec<IpAddr>,
    pub allow_direct_ip: bool,
    pub allow_loopback: bool,
    pub allow_multicast: bool,
    pub allow_global: bool,
    pub allow_non_global: bool,
    pub allow_tcp_hosts: Vec<String>,
    pub block_tcp_hosts: Vec<String>,
    pub allow_udp_hosts: Vec<String>,
    pub block_udp_hosts: Vec<String>,
    pub allow_hosts: Vec<String>,
    pub block_hosts: Vec<String>,
    pub allow_ports: Vec<Vec<u16>>,
    pub block_ports: Vec<Vec<u16>>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub server: ServerConfig,
    pub wisp: WispConfig,
    pub stream: StreamConfig,
}

#[doc(hidden)]
#[derive(Debug)]
struct ConfigCache {
    pub blocked_ports: Vec<RangeInclusive<u16>>,
    pub allowed_ports: Vec<RangeInclusive<u16>>,

    pub allowed_hosts: RegexSet,
    pub blocked_hosts: RegexSet,

    pub allowed_tcp_hosts: RegexSet,
    pub blocked_tcp_hosts: RegexSet,

    pub allowed_udp_hosts: RegexSet,
    pub blocked_udp_hosts: RegexSet,
}

lazy_static! {
    #[doc(hidden)]
    static ref CONFIG_CACHE: ConfigCache = {
        ConfigCache {
            allowed_ports: CONFIG
                .stream
                .allow_ports
                .iter()
                .map(|x| x[0]..=x[1])
                .collect(),
            blocked_ports: CONFIG
                .stream
                .block_ports
                .iter()
                .map(|x| x[0]..=x[1])
                .collect(),

            allowed_hosts: RegexSet::new(&CONFIG.stream.allow_hosts).unwrap(),
            blocked_hosts: RegexSet::new(&CONFIG.stream.block_hosts).unwrap(),

            allowed_tcp_hosts: RegexSet::new(&CONFIG.stream.allow_tcp_hosts).unwrap(),
            blocked_tcp_hosts: RegexSet::new(&CONFIG.stream.block_tcp_hosts).unwrap(),

            allowed_udp_hosts: RegexSet::new(&CONFIG.stream.allow_udp_hosts).unwrap(),
            blocked_udp_hosts: RegexSet::new(&CONFIG.stream.block_udp_hosts).unwrap(),
        }
    };
}

#[doc(hidden)]
pub async fn validate_config_cache() {
    let _ = CONFIG_CACHE.allowed_ports;
    CONFIG.wisp.to_opts().await.unwrap();
    RESOLVER.clear_cache();
    crate::stream::clear_resolve_cache();
}

impl StatsEndpoint {
    pub fn get_endpoint(&self) -> Option<String> {
        match self {
            Self::SameServer(x) => Some(x.clone()),
            Self::SeparateServer(_) => None,
        }
    }

    pub fn get_bindaddr(&self) -> Option<BindAddr> {
        match self {
            Self::SameServer(_) => None,
            Self::SeparateServer(x) => Some(x.clone()),
        }
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: (SocketType::default(), "127.0.0.1:4001".to_string()),
            transport: SocketTransport::default(),
            resolve_ipv6: false,
            tcp_nodelay: true,
            file_raw_mode: false,
            tls_keypair: None,

            stats_endpoint: None,

            use_real_ip_headers: false,
            websocket_origin_scheme: None,
            non_ws_response: ":3".to_string(),

            max_message_size: tuning::max_message_size(),

            log_level: LevelFilter::Info,
            runtime: RuntimeFlavor::default(),
        }
    }
}

impl Default for WispConfig {
    fn default() -> Self {
        Self {
            buffer_size: tuning::wisp_buffer_size(),
            allow_wsproxy: true,
            prefix: String::new(),
            ping_interval_secs: default_ping_interval_secs(),
            resolve_cache_ttl_secs: default_resolve_cache_ttl_secs(),
            resolve_cache_max_entries: default_resolve_cache_max_entries(),

            #[cfg(feature = "speed-limit")]
            read_limit: f64::INFINITY,
            #[cfg(feature = "speed-limit")]
            write_limit: f64::INFINITY,

            wisp_v2: true,
            extensions: vec![ProtocolExtension::Udp, ProtocolExtension::Motd],
            auth_extension: None,

            password_extension_users: HashMap::new(),
            password_extension_required: true,
            certificate_extension_keys: Vec::new(),
            certificate_extension_required: true,

            motd_extension: default_motd(),
        }
    }
}

impl WispConfig {
    #[doc(hidden)]
    pub fn has_wispnet(&self) -> bool {
        self.extensions.contains(&ProtocolExtension::Wispnet)
    }

    #[doc(hidden)]
    pub async fn to_opts(&self) -> anyhow::Result<(Option<WispV2Handshake>, Vec<u8>, u32)> {
        if self.wisp_v2 {
            let mut extensions: Vec<AnyProtocolExtensionBuilder> = Vec::new();
            let mut required_extensions: Vec<u8> = Vec::new();

            if self.extensions.contains(&ProtocolExtension::Udp) {
                extensions.push(AnyProtocolExtensionBuilder::new(
                    UdpProtocolExtensionBuilder,
                ));
            }

            if self.extensions.contains(&ProtocolExtension::Motd) {
                extensions.push(AnyProtocolExtensionBuilder::new(
                    MotdProtocolExtensionBuilder::Server(self.motd_extension.clone()),
                ));
            }

            match self.auth_extension {
                Some(ProtocolExtensionAuth::Password) => {
                    extensions.push(AnyProtocolExtensionBuilder::new(
                        PasswordProtocolExtensionBuilder::new_server(
                            self.password_extension_users.clone(),
                            self.password_extension_required,
                        ),
                    ));
                    if self.password_extension_required {
                        required_extensions.push(PasswordProtocolExtension::ID);
                    }
                }
                Some(ProtocolExtensionAuth::Certificate) => {
                    extensions.push(AnyProtocolExtensionBuilder::new(
                        CertAuthProtocolExtensionBuilder::new_server(
                            get_certificates_from_paths(self.certificate_extension_keys.clone())
                                .await?,
                            self.certificate_extension_required,
                        ),
                    ));
                    if self.certificate_extension_required {
                        required_extensions.push(CertAuthProtocolExtension::ID);
                    }
                }
                None => {}
            }

            Ok((
                Some(WispV2Handshake::new(extensions)),
                required_extensions,
                self.buffer_size,
            ))
        } else {
            Ok((None, Vec::new(), self.buffer_size))
        }
    }
}

impl Default for StreamConfig {
    fn default() -> Self {
        Self {
            tcp_nodelay: true,
            buffer_size: tuning::stream_buffer_size(),
            resolve_timeout_ms: default_resolve_timeout_ms(),
            connect_timeout_ms: default_connect_timeout_ms(),

            allow_udp: true,
            allow_wsproxy_udp: false,
            #[cfg(feature = "twisp")]
            allow_twisp: false,

            dns_servers: Vec::new(),

            allow_direct_ip: true,
            allow_loopback: true,
            allow_multicast: true,

            allow_global: true,
            allow_non_global: true,

            allow_tcp_hosts: Vec::new(),
            block_tcp_hosts: Vec::new(),

            allow_udp_hosts: Vec::new(),
            block_udp_hosts: Vec::new(),

            allow_hosts: Vec::new(),
            block_hosts: Vec::new(),

            allow_ports: Vec::new(),
            block_ports: Vec::new(),
        }
    }
}

impl StreamConfig {
    #[doc(hidden)]
    pub fn allowed_ports(&self) -> &'static [RangeInclusive<u16>] {
        &CONFIG_CACHE.allowed_ports
    }

    #[doc(hidden)]
    pub fn blocked_ports(&self) -> &'static [RangeInclusive<u16>] {
        &CONFIG_CACHE.blocked_ports
    }

    #[doc(hidden)]
    pub fn allowed_hosts(&self) -> &RegexSet {
        &CONFIG_CACHE.allowed_hosts
    }

    #[doc(hidden)]
    pub fn blocked_hosts(&self) -> &RegexSet {
        &CONFIG_CACHE.blocked_hosts
    }

    #[doc(hidden)]
    pub fn allowed_tcp_hosts(&self) -> &RegexSet {
        &CONFIG_CACHE.allowed_tcp_hosts
    }

    #[doc(hidden)]
    pub fn blocked_tcp_hosts(&self) -> &RegexSet {
        &CONFIG_CACHE.blocked_tcp_hosts
    }

    #[doc(hidden)]
    pub fn allowed_udp_hosts(&self) -> &RegexSet {
        &CONFIG_CACHE.allowed_udp_hosts
    }

    #[doc(hidden)]
    pub fn blocked_udp_hosts(&self) -> &RegexSet {
        &CONFIG_CACHE.blocked_udp_hosts
    }
}

impl Config {
    #[doc(hidden)]
    pub fn ser(&self) -> anyhow::Result<String> {
        Ok(match CLI.format {
            ConfigFormat::Json => serde_json::to_string_pretty(self)?,
            #[cfg(feature = "toml")]
            ConfigFormat::Toml => toml::to_string_pretty(self)?,
            #[cfg(feature = "yaml")]
            ConfigFormat::Yaml => serde_yaml::to_string(self)?,
        })
    }

    #[doc(hidden)]
    pub fn de(string: &str) -> anyhow::Result<Self> {
        Ok(match CLI.format {
            ConfigFormat::Json => serde_json::from_str(string)?,
            #[cfg(feature = "toml")]
            ConfigFormat::Toml => toml::from_str(string)?,
            #[cfg(feature = "yaml")]
            ConfigFormat::Yaml => serde_yaml::from_str(string)?,
        })
    }
}

#[derive(Debug, Clone, Copy, Default, Eq, PartialEq, ValueEnum)]
#[doc(hidden)]
pub enum ConfigFormat {
    #[cfg_attr(not(any(feature = "toml", feature = "yaml")), default)]
    Json,
    #[cfg(feature = "toml")]
    #[default]
    Toml,
    #[cfg(feature = "yaml")]
    #[cfg_attr(all(not(feature = "toml"), feature = "yaml"), default)]
    Yaml,
}

#[doc(hidden)]
#[derive(Parser, Debug)]
#[command(version = VERSION_STRING)]
pub struct Cli {
    pub config: Option<PathBuf>,
    #[arg(short, long, value_enum, default_value_t = ConfigFormat::default())]
    pub format: ConfigFormat,
    #[arg(long)]
    pub default_config: bool,
}
