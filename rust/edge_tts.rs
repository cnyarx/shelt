use futures_util::{SinkExt, StreamExt};
use ring::digest::{digest, SHA256};
use rustls::{pki_types::CertificateDer, ClientConfig, RootCertStore};
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio_tungstenite::{
    tungstenite::{
        client::IntoClientRequest,
        http::{header, HeaderValue},
        Message,
    },
    Connector,
};

const WSS_BASE: &str = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const TRUSTED_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WINDOWS_EPOCH_TICKS: u128 = 116_444_736_000_000_000;
const GEC_TICK_INTERVAL: u128 = 3_000_000_000;
const USER_AGENT: &str = "Mozilla/5.0 (Linux; Android 10; HD1913) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.7499.193 Mobile Safari/537.36 EdgA/143.0.3650.125";
const ORIGIN: &str = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";

fn unix_time() -> std::time::Duration {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap()
}

fn gen_sec_ms_gec_at(unix_time_100ns: u128) -> String {
    let ticks = WINDOWS_EPOCH_TICKS + unix_time_100ns;
    let ticks = ticks - ticks % GEC_TICK_INTERVAL;
    let input = format!("{ticks}{TRUSTED_CLIENT_TOKEN}");
    let hash = digest(&SHA256, input.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in hash.as_ref() {
        hex.push_str(&format!("{byte:02X}"));
    }
    hex
}

fn gen_sec_ms_gec() -> String {
    gen_sec_ms_gec_at(unix_time().as_nanos() / 100)
}

fn http_date_at(secs: u64) -> String {
    let days = (secs / 86400) as i64;
    let day_of_week = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"][(days % 7) as usize];
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let month_name = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ][(month - 1) as usize];
    let remaining = secs % 86400;
    let hour = remaining / 3600;
    let minute = (remaining % 3600) / 60;
    let second = remaining % 60;
    format!("{day_of_week}, {day:02} {month_name} {year} {hour:02}:{minute:02}:{second:02} GMT")
}

fn http_date() -> String {
    http_date_at(unix_time().as_secs())
}

fn request_id_at(nanos: u128) -> String {
    format!("{nanos:032x}")
}

fn request_id() -> String {
    request_id_at(unix_time().as_nanos())
}

fn tls_connector() -> Result<Connector, rustls::Error> {
    let mut roots = RootCertStore::empty();
    roots.add(CertificateDer::from(
        &include_bytes!("digicert-global-root-g2.der")[..],
    ))?;
    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Connector::Rustls(Arc::new(config)))
}

pub fn extract_audio_from_binary(bytes: &[u8], turn_start: bool, response: bool) -> Option<&[u8]> {
    if !(turn_start || response) {
        return None;
    }
    if bytes.len() < 2 {
        return None;
    }
    let header_len = u16::from_be_bytes([bytes[0], bytes[1]]) as usize + 2;
    if header_len > bytes.len() {
        return None;
    }
    Some(&bytes[header_len..])
}

pub async fn synthesize(
    text: &str,
    voice_name: &str,
    rate_percent: i32,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    let sec_ms_gec = gen_sec_ms_gec();
    let conn_id = request_id();
    let url = format!(
        "{WSS_BASE}&ConnectionId={conn_id}&Sec-MS-GEC={sec_ms_gec}&Sec-MS-GEC-Version=1-130.0.2849.68"
    );

    let mut req = url.into_client_request()?;
    let headers = req.headers_mut();
    headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert(header::USER_AGENT, HeaderValue::from_static(USER_AGENT));
    headers.insert(header::ORIGIN, HeaderValue::from_static(ORIGIN));
    let (mut ws, _) =
        tokio_tungstenite::connect_async_tls_with_config(req, None, false, Some(tls_connector()?))
            .await?;

    let config_msg = format!(
        "X-Timestamp:{}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n\
         {{\"context\":{{\"synthesis\":{{\"audio\":{{\"metadataoptions\":{{\"sentenceBoundaryEnabled\":\"false\",\
         \"wordBoundaryEnabled\":\"true\"}},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}}}}}",
        http_date(),
    );
    ws.send(Message::Text(config_msg.into())).await?;

    let ssml = format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>\
         <voice name='{voice_name}'><prosody pitch='+0Hz' rate='{rate_percent:+}%' volume='+0%'>{text}</prosody></voice></speak>",
    );
    let ssml_msg = format!(
        "X-RequestId:{}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{}\r\nPath:ssml\r\n\r\n{ssml}",
        request_id(),
        http_date(),
    );
    ws.send(Message::Text(ssml_msg.into())).await?;

    let mut audio = Vec::new();
    let mut turn_start = false;
    let mut response = false;
    loop {
        let message = ws.next().await.ok_or("WebSocket stream ended")??;
        match message {
            Message::Text(text) => {
                if text.contains("turn.end") {
                    break;
                }
                if text.contains("turn.start") {
                    turn_start = true;
                } else if text.contains("response") {
                    response = true;
                }
            }
            Message::Binary(bytes) => {
                if let Some(audio_chunk) = extract_audio_from_binary(&bytes, turn_start, response) {
                    audio.extend_from_slice(audio_chunk);
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    Ok(audio)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_date_at_epoch() {
        assert_eq!(http_date_at(0), "Thu, 01 Jan 1970 00:00:00 GMT");
    }

    #[test]
    fn http_date_at_known() {
        assert_eq!(http_date_at(1_700_000_000), "Tue, 14 Nov 2023 22:13:20 GMT");
    }

    #[test]
    fn http_date_at_roundtrip() {
        let now = unix_time().as_secs();
        let formatted = http_date_at(now);
        assert!(formatted.ends_with(" GMT"));
        assert_eq!(formatted.len(), 29);
    }

    #[test]
    fn request_id_is_32_hex() {
        let id = request_id_at(0);
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn request_id_is_nonzero() {
        let id = request_id_at(123_456_789);
        assert_eq!(id, "000000000000000000000000075bcd15");
    }

    #[test]
    fn gec_is_64_uppercase_hex() {
        let gec = gen_sec_ms_gec_at(0);
        assert_eq!(gec.len(), 64);
        assert!(gec.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(gec.chars().all(|c| !c.is_ascii_lowercase()));
    }

    #[test]
    fn gec_known_value() {
        let gec = gen_sec_ms_gec_at(0);
        assert_eq!(
            gec,
            "7ECB79D14E3AA576D2D79E6D487A1388156D91E614B1BE11C64226A29BC8DD8C"
        );
    }

    #[test]
    fn gec_ticks_are_aligned() {
        let gec1 = gen_sec_ms_gec_at(0);
        let gec2 = gen_sec_ms_gec_at(GEC_TICK_INTERVAL - 1);
        let gec3 = gen_sec_ms_gec_at(GEC_TICK_INTERVAL * 100);
        assert_eq!(gec1, gec2);
        assert_ne!(gec1, gec3);
    }

    #[test]
    fn extract_audio_no_turn_or_response() {
        let audio = extract_audio_from_binary(&[0, 0, 1, 2, 3], false, false);
        assert!(audio.is_none());
    }

    #[test]
    fn extract_audio_header_too_short() {
        let audio = extract_audio_from_binary(&[0xFF], true, false);
        assert!(audio.is_none());
    }

    #[test]
    fn extract_audio_header_beyond_len() {
        let audio = extract_audio_from_binary(&[0, 10, 1], true, false);
        assert!(audio.is_none());
    }

    #[test]
    fn extract_audio_zero_header() {
        let audio = extract_audio_from_binary(&[0, 0, 1, 2, 3], true, false);
        assert_eq!(audio, Some(&[1_u8, 2, 3][..]));
    }

    #[test]
    fn extract_audio_valid_header() {
        let audio = extract_audio_from_binary(&[0, 3, 0, 0, 0, 0xAA, 0xBB], false, true);
        assert_eq!(audio, Some(&[0xAA_u8, 0xBB][..]));
    }
}
