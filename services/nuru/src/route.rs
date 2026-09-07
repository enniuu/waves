use std::{fmt::Display, future::Future, io::Cursor};

use anyhow::Context;
use bytes::Bytes;
use futures_util::future::Either;
use http_body_util::Full;
use hyper::{
    body::Incoming, header::SEC_WEBSOCKET_PROTOCOL, server::conn::http1::Builder,
    service::service_fn, upgrade::OnUpgrade, HeaderMap, Request, Response, StatusCode,
};
use hyper_util::rt::TokioIo;
use log::{debug, error, trace};
use tokio_util::codec::{FramedRead, FramedWrite, LengthDelimitedCodec};
use tokio_websockets::Limits;
use wisp_mux::ws::{
    TokioWebsocketsTransport, TransportExt, WebSocketSplitRead, WebSocketSplitWrite,
};

use crate::{
    config::SocketTransport,
    generate_stats,
    listener::{ServerStream, ServerStreamExt, ServerStreamRead, ServerStreamWrite},
    stream::WebSocketStreamWrapper,
    upgrade::{is_upgrade_request, origin_allowed, upgrade},
    util_chain::{chain, Chain},
    util_map_err::MapErr,
    CONFIG, NEGATIVE, POSITIVE,
};

pub type WispStreamRead = Either<
    WebSocketSplitRead<TokioWebsocketsTransport<Chain<Cursor<Bytes>, ServerStream>>>,
    MapErr<FramedRead<ServerStreamRead, LengthDelimitedCodec>>,
>;
pub type WispWsStreamWrite =
    WebSocketSplitWrite<TokioWebsocketsTransport<Chain<Cursor<Bytes>, ServerStream>>>;
pub type WispStreamWrite =
    Either<WispWsStreamWrite, MapErr<FramedWrite<ServerStreamWrite, LengthDelimitedCodec>>>;
pub type WispResult = (WispStreamRead, WispStreamWrite);

pub enum ServerRouteResult {
    Wisp {
        stream: WispResult,
        has_ws_protocol: bool,
    },
    Wispnet {
        stream: WispResult,
    },
    WsProxy {
        stream: WebSocketStreamWrapper,
        path: String,
        udp: bool,
    },
}

impl Display for ServerRouteResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Wisp { .. } => write!(f, "wisp"),
            Self::Wispnet { .. } => write!(f, "wispnet"),
            Self::WsProxy { path, udp, .. } => write!(f, "wsproxy path {path:?} udp {udp:?}"),
        }
    }
}

type Body = Full<Bytes>;

fn health_resp() -> anyhow::Result<Response<Body>> {
    Ok(Response::builder()
        .status(StatusCode::OK)
        .body(Body::new("oki".into()))?)
}

fn non_ws_resp() -> anyhow::Result<Response<Body>> {
    Ok(Response::builder()
        .status(StatusCode::OK)
        .body(Body::new(CONFIG.server.non_ws_response.as_bytes().into()))?)
}

async fn send_stats() -> anyhow::Result<Response<Body>> {
    match generate_stats().await {
        Ok(x) => {
            debug!("sent server stats to http client{}", POSITIVE);
            Ok(Response::builder()
                .status(StatusCode::OK)
                .body(Body::new(x.into()))?)
        }
        Err(x) => {
            error!("failed to send stats to http client: {:?}{}", x, NEGATIVE);
            Ok(Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::new(negative_message!("stats are unavailable").into()))?)
        }
    }
}

fn get_header(headers: &HeaderMap, header: &str) -> Option<String> {
    headers
        .get(header)
        .and_then(|x| x.to_str().ok())
        .map(ToString::to_string)
}

enum HttpUpgradeResult {
    Wisp {
        has_ws_protocol: bool,
        is_wispnet: bool,
    },
    WsProxy {
        path: String,
        udp: bool,
    },
}

async fn ws_upgrade<F, R>(
    mut req: Request<Incoming>,
    stats_endpoint: Option<String>,
    callback: F,
) -> anyhow::Result<Response<Body>>
where
    F: FnOnce(OnUpgrade, HttpUpgradeResult, Option<String>) -> R + Send + 'static,
    R: Future<Output = anyhow::Result<()>> + Send,
{
    let is_upgrade = is_upgrade_request(&req);

    if !is_upgrade {
        if req.uri().path() == "/health" {
            return health_resp();
        }

        if let Some(stats_endpoint) = stats_endpoint {
            if req.uri().path() == stats_endpoint {
                return send_stats().await;
            }
        }

        debug!("sent non-websocket response to http client{}", POSITIVE);
        return non_ws_resp();
    }

    if let Some(scheme) = &CONFIG.server.websocket_origin_scheme {
        if !origin_allowed(req.headers(), scheme) {
            return Ok(Response::builder()
                .status(StatusCode::FORBIDDEN)
                .header(hyper::header::CACHE_CONTROL, "no-store")
                .body(Body::new(negative_message!("connection not allowed").into()))?);
        }
    }

    trace!("received websocket request");

    let (resp, fut) = upgrade(&mut req)?;
    let mut resp = Response::from_parts(resp.into_parts().0, Body::new(Bytes::new()));
    let headers = req.headers();
    let ip_header = if CONFIG.server.use_real_ip_headers {
        get_header(headers, "x-real-ip").or_else(|| get_header(headers, "x-forwarded-for"))
    } else {
        None
    };

    let ws_protocol = headers.get(SEC_WEBSOCKET_PROTOCOL);
    let req_path = req.uri().path().to_string();

    let wisp_prefix = CONFIG.wisp.prefix.as_str();
    let is_wisp_path = req_path.starts_with(wisp_prefix)
        && req_path.ends_with('/')
        && req_path.len() == (wisp_prefix.len() + 1);
    if is_wisp_path {
        let has_ws_protocol = ws_protocol.is_some();
        let is_wispnet =
            CONFIG.wisp.has_wispnet() && req.uri().query().unwrap_or_default() == "net";
        tokio::spawn(async move {
            if let Err(err) = (callback)(
                fut,
                HttpUpgradeResult::Wisp {
                    has_ws_protocol,
                    is_wispnet,
                },
                ip_header,
            )
            .await
            {
                error!("failed to serve client: {:?}{}", err, NEGATIVE);
            }
        });
        if let Some(protocol) = ws_protocol {
            resp.headers_mut()
                .append(SEC_WEBSOCKET_PROTOCOL, protocol.clone());
        }
    } else if CONFIG.wisp.allow_wsproxy {
        let udp = req.uri().query().unwrap_or_default() == "udp";
        tokio::spawn(async move {
            if let Err(err) = (callback)(
                fut,
                HttpUpgradeResult::WsProxy {
                    path: req_path,
                    udp,
                },
                ip_header,
            )
            .await
            {
                error!("failed to serve client: {:?}{}", err, NEGATIVE);
            }
        });
    } else {
        debug!("sent non-websocket response to http client{}", POSITIVE);
        return non_ws_resp();
    }

    Ok(resp)
}

pub async fn route_stats(stream: ServerStream) -> anyhow::Result<()> {
    let stream = TokioIo::new(stream);
    Builder::new()
        .serve_connection(stream, service_fn(move |_| async { send_stats().await }))
        .await?;
    Ok(())
}

pub async fn route(
    stream: ServerStream,
    stats_endpoint: Option<String>,
    callback: impl FnOnce(ServerRouteResult, Option<String>) + Clone + Send + 'static,
) -> anyhow::Result<()> {
    match CONFIG.server.transport {
        SocketTransport::WebSocket => {
            let stream = TokioIo::new(stream);

            Builder::new()
                .serve_connection(
                    stream,
                    service_fn(move |req| {
                        let callback = callback.clone();

                        ws_upgrade(
                            req,
                            stats_endpoint.clone(),
                            |fut, res, maybe_ip| async move {
                                let ws = fut
                                    .await
                                    .context(negative_message!("failed to await upgrade future"))?;

                                match res {
                                    HttpUpgradeResult::Wisp {
                                        has_ws_protocol,
                                        is_wispnet,
                                    } => {
                                        let ws = ws.downcast::<TokioIo<ServerStream>>().map_err(
                                            |_| {
                                                anyhow::anyhow!(negative_message!(
                                                    "unexpected upgraded stream type"
                                                ))
                                            },
                                        )?;
                                        let ws =
                                            chain(Cursor::new(ws.read_buf), ws.io.into_inner());

                                        let ws = tokio_websockets::ServerBuilder::new()
                                            .limits(Limits::default().max_payload_len(Some(
                                                CONFIG.server.max_message_size,
                                            )))
                                            .serve(ws);
                                        let (read, write) =
                                            TokioWebsocketsTransport(ws).split_fast();

                                        let result = if is_wispnet {
                                            ServerRouteResult::Wispnet {
                                                stream: (Either::Left(read), Either::Left(write)),
                                            }
                                        } else {
                                            ServerRouteResult::Wisp {
                                                stream: (Either::Left(read), Either::Left(write)),
                                                has_ws_protocol,
                                            }
                                        };

                                        (callback)(result, maybe_ip);
                                    }
                                    HttpUpgradeResult::WsProxy { path, udp } => {
                                        let ws = tokio_websockets::ServerBuilder::new()
                                            .limits(Limits::default().max_payload_len(Some(
                                                CONFIG.server.max_message_size,
                                            )))
                                            .serve(TokioIo::new(ws));
                                        let ws = WebSocketStreamWrapper(ws);
                                        (callback)(
                                            ServerRouteResult::WsProxy {
                                                stream: ws,
                                                path,
                                                udp,
                                            },
                                            maybe_ip,
                                        );
                                    }
                                }

                                Ok(())
                            },
                        )
                    }),
                )
                .with_upgrades()
                .await?;
        }
        SocketTransport::LengthDelimitedLe => {
            let codec = LengthDelimitedCodec::builder()
                .little_endian()
                .max_frame_length(CONFIG.server.max_message_size)
                .new_codec();

            let (read, write) = stream.split();
            let read = MapErr(FramedRead::new(read, codec.clone()));
            let write = MapErr(FramedWrite::new(write, codec));

            (callback)(
                ServerRouteResult::Wisp {
                    stream: (Either::Right(read), Either::Right(write)),
                    has_ws_protocol: true,
                },
                None,
            );
        }
    }
    Ok(())
}
