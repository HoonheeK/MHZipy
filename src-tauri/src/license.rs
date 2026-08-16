use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use chrono::{DateTime, Duration, Utc};
use machine_uid::get as get_machine_uid;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use winreg::enums::*;
use winreg::RegKey;

const AES_SECRET: &[u8; 32] = b"MHZipy_Super_Secret_Key_12345678";



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
    #[serde(default)]
    pub expiry_date: Option<i64>,
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
        expiry_date: None,
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

#[derive(Debug, Deserialize)]
struct GasValidationResponse {
    valid: bool,
    reason: Option<String>,
    #[serde(rename = "expiryDate")]
    expiry_date: Option<String>,
}

pub const GAS_API_URL: &str = "https://script.google.com/macros/s/AKfycbw0cCdkJF0W6O0IhhHtm4RMmadyVHKRLF-g-tDkUAMAuasns1idpcPco9bGPNq2DwS9SQ/exec";
pub const WEB_APP_URL: &str = "https://mhzipy-update.marh-sw.com/buy.html";

pub fn verify_license_code(code: &str, current_device_id: &str) -> Result<LicensePayload, String> {
    println!("[License] Verifying license code via Google Apps Script...");
    
    let url = format!(
        "{}?action=validate&code={}&deviceId={}",
        GAS_API_URL,
        urlencoding::encode(code),
        urlencoding::encode(current_device_id)
    );
    
    let client = reqwest::blocking::Client::new();
    let res = client.get(&url)
        .send()
        .map_err(|e| {
            println!("[License Error] Network error: {:?}", e);
            format!("Network error: {}", e)
        })?;
        
    let data: GasValidationResponse = res.json().map_err(|e| {
        println!("[License Error] Invalid response: {:?}", e);
        format!("Invalid response format: {}", e)
    })?;
    
    if !data.valid {
        return Err(data.reason.unwrap_or_else(|| "Invalid license code".to_string()));
    }
    
    if let Some(ref date_str) = data.expiry_date {
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(date_str) {
            println!("[License] Verification successful! Expiry: {}", dt);
            return Ok(LicensePayload {
                email: "server-validated".to_string(), // GAS script doesn't return email, so we skip checking it.
                device_id: current_device_id.to_string(),
                expires_at: dt.timestamp(),
            });
        }
    }
    
    Err("Failed to parse expiry date from server".to_string())
}

#[allow(unreachable_code, unused_variables)]
pub fn get_license_status(app: &AppHandle) -> LicenseInfo {
    let device_id = get_device_id();

    let config = load_config(app);
    let now = Utc::now();

    if let Some(expiry_date) = config.expiry_date {
        let expiry = DateTime::from_timestamp(expiry_date, 0).unwrap_or(DateTime::<Utc>::MIN_UTC);
        if now < expiry {
            return LicenseInfo {
                status: LicenseStatusType::Activated {
                    expiry_date,
                },
                device_id,
            };
        }
        return LicenseInfo {
            status: LicenseStatusType::Expired,
            device_id,
        };
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

pub fn activate(app: &AppHandle, _email: &str, code: &str) -> Result<LicenseInfo, String> {
    let device_id = get_device_id();
    let payload = verify_license_code(code, &device_id)?;

    // Removed email check since Google Apps Script validation doesn't return the email.
    // The device_id verification guarantees the license is for this computer.

    if Utc::now().timestamp() >= payload.expires_at {
        return Err("This license has already expired".to_string());
    }

    let mut config = load_config(app);
    config.license_key = Some(code.to_string());
    config.expiry_date = Some(payload.expires_at);
    save_config(app, &config);

    Ok(get_license_status(app))
}
