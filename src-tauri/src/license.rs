use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use chrono::{DateTime, Duration, Utc};
use machine_uid::get as get_machine_uid;
use rsa::{pkcs8::DecodePublicKey, Pkcs1v15Sign, RsaPublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use winreg::enums::*;
use winreg::RegKey;

const AES_SECRET: &[u8; 32] = b"MHZipy_Super_Secret_Key_12345678";

// Temporary placeholder key - you should replace this with a real key
pub const PUBLIC_KEY_PEM: &str = r#"-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA7pkfcXhvpLOu97ZNnadO
6276993x7A015huTPSys+7y88cI7+VsaC0XX+xKzbn0lw1F0AArrgs2RoDUC2vuE
ObJ+QoYO/JGwdnN5KfiFR+Xi6SSCntLQx7rvK4zjpQMGXdRcLqLk682m+lCTrqGW
PEmUMreBe856Ka7MUJFA3essWco7HZcU9UrTdkFwSmO1auokZVVBlZiIlauMNAl3
VmpbpoyU9XItFT8CLIHe+j4I2uAjwD0uqUK258hkyO3zwYbfC+1DD8gRjPgiKpfy
WR6df612mmDqqH7tsKL191ZB0jUTjkLexuxS+HqyPu92J4qoxqEtd5o8uW2oQF1V
AQIDAQAB
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

fn get_registry_key() -> std::io::Result<RegKey> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu.create_subkey("Software\\MHZipy\\License")?;
    Ok(key)
}

fn get_deterministic_nonce(config: &LicenseConfig) -> [u8; 12] {
    let mut hasher = Sha256::new();
    hasher.update(&config.first_run_date.to_be_bytes());
    if let Some(key) = &config.license_key {
        hasher.update(key.as_bytes());
    }
    hasher.update(get_device_id().as_bytes());
    let hash = hasher.finalize();
    let mut nonce = [0u8; 12];
    nonce.copy_from_slice(&hash[0..12]);
    nonce
}

fn encrypt_config(config: &LicenseConfig) -> String {
    use base64::{engine::general_purpose::STANDARD as b64, Engine as _};
    let key = Key::<Aes256Gcm>::from_slice(AES_SECRET);
    let cipher = Aes256Gcm::new(key);
    let nonce_bytes = get_deterministic_nonce(config);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let json = serde_json::to_string(config).unwrap_or_default();
    let ciphertext = cipher.encrypt(nonce, json.as_bytes()).unwrap_or_default();

    let mut payload = nonce_bytes.to_vec();
    payload.extend_from_slice(&ciphertext);
    b64.encode(payload)
}

fn decrypt_config(token: &str) -> Option<LicenseConfig> {
    use base64::{engine::general_purpose::STANDARD as b64, Engine as _};
    let payload = b64.decode(token).ok()?;
    if payload.len() < 12 {
        return None;
    }
    let (nonce_bytes, ciphertext) = payload.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);

    let key = Key::<Aes256Gcm>::from_slice(AES_SECRET);
    let cipher = Aes256Gcm::new(key);
    let plaintext = cipher.decrypt(nonce, ciphertext).ok()?;

    let json = String::from_utf8(plaintext).ok()?;
    serde_json::from_str(&json).ok()
}

pub fn load_config(_app: &AppHandle) -> LicenseConfig {
    if let Ok(key) = get_registry_key() {
        if let Ok(token) = key.get_value::<String, _>("Token") {
            if let Some(config) = decrypt_config(&token) {
                return config;
            }
        }
    }

    let config = LicenseConfig {
        first_run_date: Utc::now().timestamp(),
        license_key: None,
    };
    save_config(_app, &config);
    config
}

pub fn save_config(_app: &AppHandle, config: &LicenseConfig) {
    if let Ok(key) = get_registry_key() {
        let token = encrypt_config(config);
        let _ = key.set_value("Token", &token);

        let date_str = DateTime::from_timestamp(config.first_run_date, 0)
            .map(|dt| dt.to_rfc3339())
            .unwrap_or_default();
        let _ = key.set_value("FirstRunDate", &date_str);
    }
}

pub fn verify_license_code(code: &str, current_device_id: &str) -> Result<LicensePayload, String> {
    println!("[License] Verifying license code...");
    let parts: Vec<&str> = code.split('.').collect();
    if parts.len() != 2 {
        println!("[License Error] Invalid format: missing '.' separator");
        return Err("Invalid license code format".to_string());
    }

    use base64::{engine::general_purpose::STANDARD as b64, Engine as _};
    let payload_bytes = b64.decode(parts[0]).map_err(|e| {
        println!("[License Error] Failed to decode payload base64: {:?}", e);
        "Failed to decode payload".to_string()
    })?;
    let signature_bytes = b64.decode(parts[1]).map_err(|e| {
        println!("[License Error] Failed to decode signature base64: {:?}", e);
        "Failed to decode signature".to_string()
    })?;

    let payload_str = String::from_utf8(payload_bytes.clone()).map_err(|e| {
        println!("[License Error] Invalid UTF-8 in payload: {:?}", e);
        "Invalid UTF-8 in payload".to_string()
    })?;

    let payload: LicensePayload = serde_json::from_str(&payload_str).map_err(|e| {
        println!(
            "[License Error] Failed to parse JSON payload: {:?} / String: {}",
            e, payload_str
        );
        "Failed to parse payload".to_string()
    })?;

    if payload.device_id != current_device_id {
        println!(
            "[License Error] Device ID mismatch. Expected: '{}', Got: '{}'",
            current_device_id, payload.device_id
        );
        return Err("License is registered to a different device".to_string());
    }

    let public_key = RsaPublicKey::from_public_key_pem(PUBLIC_KEY_PEM).map_err(|e| {
        println!(
            "[License Error] Failed to load public key from PEM: {:?}",
            e
        );
        "Failed to load public key".to_string()
    })?;

    let mut hasher = Sha256::new();
    hasher.update(&payload_bytes);
    let hash = hasher.finalize();

    public_key
        .verify(Pkcs1v15Sign::new::<Sha256>(), &hash, &signature_bytes)
        .map_err(|e| {
            println!("[License Error] RSA Signature verification failed: {:?}", e);
            "Invalid license signature".to_string()
        })?;

    println!("[License] Verification successful!");
    Ok(payload)
}

pub fn get_license_status(app: &AppHandle) -> LicenseInfo {
    let config = load_config(app);
    let device_id = get_device_id();
    let now = Utc::now();

    if let Some(key) = &config.license_key {
        if let Ok(payload) = verify_license_code(key, &device_id) {
            let expiry =
                DateTime::from_timestamp(payload.expires_at, 0).unwrap_or(DateTime::<Utc>::MIN_UTC);
            if now < expiry {
                return LicenseInfo {
                    status: LicenseStatusType::Activated {
                        expiry_date: payload.expires_at,
                    },
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
