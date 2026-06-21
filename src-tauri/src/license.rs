use chrono::{DateTime, Utc, Duration};
use machine_uid::get as get_machine_uid;
use rsa::{pkcs8::DecodePublicKey, RsaPublicKey, Pkcs1v15Sign};
use sha2::{Sha256, Digest};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

// Temporary placeholder key - you should replace this with a real key
pub const PUBLIC_KEY_PEM: &str = r#"-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuW4wKjBqF9P7a5146l3R
l2R8/n32WvE8Z/4pS8WcW3Y+1t0D/WdI5D9O4Kx4sF+sLp1kS4t01tW3/4l0vI5T
o7y0D1sW6w8l1+3h7r6/0q9p1vX2qF/2/zZkK9n8xP7Lp+M3vP2Bv9Zk6o4n5q9r
q0zX+0vY1p6H6k6r/6B5h5G/7p7B8w+1t0D/WdI5D9O4Kx4sF+sLp1kS4t01tW3/
4l0vI5To7y0D1sW6w8l1+3h7r6/0q9p1vX2qF/2/zZkK9n8xP7Lp+M3vP2Bv9Zk6
o4n5q9rq0zX+0vY1p6H6k6r/6B5h5G/7p7B8w+1t0D/WdI5D9O4Kx4sF+sLp1kS4
t01tW3/4l0vI5To7y0D1sW6w8l1+3h7r6/0q9p1vX2qF/2/zZkK9n8xP7Lp+M3vP
2Bv9Zk6o4n5q9rq0zX+0vY1p6H6k6r/6B5h5G/7p7B8wIDAQAB
-----END PUBLIC KEY-----"#;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum LicenseStatusType {
    Trial { days_left: i32 },
    Activated { expiry_date: i64 },
    Expired,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LicenseInfo {
    pub status: LicenseStatusType,
    pub device_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LicenseConfig {
    pub first_run_date: i64,
    pub license_key: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LicensePayload {
    pub email: String,
    pub device_id: String,
    pub expires_at: i64,
}

pub fn get_device_id() -> String {
    get_machine_uid().unwrap_or_else(|_| "UNKNOWN_DEVICE_ID".to_string())
}

fn get_config_path(app: &AppHandle) -> PathBuf {
    let mut path = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    fs::create_dir_all(&path).unwrap_or_default();
    path.push("license_config.json");
    path
}

pub fn load_config(app: &AppHandle) -> LicenseConfig {
    let path = get_config_path(app);
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(config) = serde_json::from_str::<LicenseConfig>(&content) {
                return config;
            }
        }
    }

    let config = LicenseConfig {
        first_run_date: Utc::now().timestamp(),
        license_key: None,
    };
    save_config(app, &config);
    config
}

pub fn save_config(app: &AppHandle, config: &LicenseConfig) {
    let path = get_config_path(app);
    if let Ok(content) = serde_json::to_string_pretty(config) {
        let _ = fs::write(path, content);
    }
}

pub fn verify_license_code(code: &str, current_device_id: &str) -> Result<LicensePayload, String> {
    let parts: Vec<&str> = code.split('.').collect();
    if parts.len() != 2 {
        return Err("Invalid license code format".to_string());
    }

    use base64::{Engine as _, engine::general_purpose::STANDARD as b64};
    let payload_bytes = b64.decode(parts[0]).map_err(|_| "Failed to decode payload".to_string())?;
    let signature_bytes = b64.decode(parts[1]).map_err(|_| "Failed to decode signature".to_string())?;

    let payload_str = String::from_utf8(payload_bytes.clone()).map_err(|_| "Invalid UTF-8 in payload".to_string())?;
    let payload: LicensePayload = serde_json::from_str(&payload_str).map_err(|_| "Failed to parse payload".to_string())?;

    if payload.device_id != current_device_id {
        return Err("License is registered to a different device".to_string());
    }

    let public_key = RsaPublicKey::from_public_key_pem(PUBLIC_KEY_PEM).map_err(|_| "Failed to load public key".to_string())?;
    
    let mut hasher = Sha256::new();
    hasher.update(&payload_bytes);
    let hash = hasher.finalize();

    public_key.verify(Pkcs1v15Sign::new::<Sha256>(), &hash, &signature_bytes)
        .map_err(|_| "Invalid license signature".to_string())?;

    Ok(payload)
}

pub fn get_license_status(app: &AppHandle) -> LicenseInfo {
    let config = load_config(app);
    let device_id = get_device_id();
    let now = Utc::now();

    if let Some(key) = &config.license_key {
        if let Ok(payload) = verify_license_code(key, &device_id) {
            let expiry = DateTime::from_timestamp(payload.expires_at, 0).unwrap_or(DateTime::<Utc>::MIN_UTC);
            if now < expiry {
                return LicenseInfo {
                    status: LicenseStatusType::Activated { expiry_date: payload.expires_at },
                    device_id,
                };
            }
            // If expired, fall back to trial logic or just return expired.
            // A purchased license implies trial is over anyway if it expired.
            return LicenseInfo {
                status: LicenseStatusType::Expired,
                device_id,
            };
        }
    }

    let first_run = DateTime::from_timestamp(config.first_run_date, 0).unwrap_or(now);
    let trial_end = first_run + Duration::days(30);

    if now < trial_end {
        let days_left = (trial_end - now).num_days() as i32;
        LicenseInfo {
            status: LicenseStatusType::Trial { days_left },
            device_id,
        }
    } else {
        LicenseInfo {
            status: LicenseStatusType::Expired,
            device_id,
        }
    }
}

pub fn activate(app: &AppHandle, email: &str, code: &str) -> Result<LicenseInfo, String> {
    let device_id = get_device_id();
    let payload = verify_license_code(code, &device_id)?;

    if payload.email.to_lowercase() != email.to_lowercase() {
        return Err("Email does not match the license".to_string());
    }

    if Utc::now().timestamp() >= payload.expires_at {
        return Err("This license has already expired".to_string());
    }

    let mut config = load_config(app);
    config.license_key = Some(code.to_string());
    save_config(app, &config);

    Ok(get_license_status(app))
}
