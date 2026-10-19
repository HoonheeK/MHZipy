import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { LicenseInfo } from '../App';

interface LicenseExpiredDialogProps {
  licenseInfo: LicenseInfo;
  defaultEmail?: string;
  defaultCode?: string;
  onActivated: (newInfo: LicenseInfo, email: string, code: string) => void;
}

export const LicenseExpiredDialog: React.FC<LicenseExpiredDialogProps> = ({
  licenseInfo,
  defaultEmail = '',
  defaultCode = '',
  onActivated,
}) => {
  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(15,23,42,0.95)',
        backdropFilter: 'blur(8px)',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#f8fafc',
        padding: '20px',
      }}
    >
      <h1 style={{ fontSize: '2rem', marginBottom: '10px', color: '#f87171' }}>
        License Expired
      </h1>
      <p
        style={{
          fontSize: '1.05rem',
          marginBottom: '30px',
          textAlign: 'center',
          maxWidth: '500px',
          color: '#cbd5e1',
        }}
      >
        Your trial or purchased license has expired. To continue using MHZipy,
        please purchase or enter a valid license.
      </p>

      <div
        style={{
          width: '100%',
          maxWidth: '420px',
          backgroundColor: '#1e293b',
          border: '1px solid #334155',
          padding: '24px',
          borderRadius: '12px',
          boxShadow: '0 10px 25px -5px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ marginBottom: '15px' }}>
          <label
            style={{
              display: 'block',
              marginBottom: '6px',
              fontSize: '0.85rem',
              color: '#94a3b8',
              fontWeight: 500,
            }}
          >
            Device ID (Copy to purchase)
          </label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type="text"
              value={licenseInfo.device_id}
              readOnly
              style={{
                flex: 1,
                padding: '10px',
                borderRadius: '6px',
                border: '1px solid #334155',
                backgroundColor: '#0f172a',
                color: '#f8fafc',
                fontFamily: 'monospace',
                fontSize: '0.9rem',
              }}
            />
            <button
              className="btn-secondary"
              onClick={() => navigator.clipboard.writeText(licenseInfo.device_id)}
            >
              Copy
            </button>
          </div>
        </div>

        <div style={{ marginBottom: '20px' }}>
          <label
            style={{
              display: 'block',
              marginBottom: '6px',
              fontSize: '0.85rem',
              color: '#94a3b8',
              fontWeight: 500,
            }}
          >
            Email Address
          </label>
          <input
            type="email"
            id="blockingEmail"
            defaultValue={defaultEmail}
            placeholder="name@example.com"
            style={{
              width: '100%',
              padding: '10px',
              borderRadius: '6px',
              border: '1px solid #334155',
              backgroundColor: '#0f172a',
              color: '#f8fafc',
              fontSize: '0.95rem',
              boxSizing: 'border-box',
            }}
          />
        </div>

        <button
          className="btn-primary"
          style={{ width: '100%', padding: '12px', fontSize: '1rem', marginBottom: '20px' }}
          onClick={async () => {
            const email = (document.getElementById('blockingEmail') as HTMLInputElement).value;
            if (!email) {
              alert('Please enter your email.');
              return;
            }
            try {
              const webAppUrl = await invoke<string>('get_web_app_url');
              await openUrl(`${webAppUrl}?email=${encodeURIComponent(email)}&deviceId=${encodeURIComponent(licenseInfo.device_id)}`);
            } catch (err) {
              console.error('Failed to open web app url:', err);
            }
          }}
        >
          Buy License
        </button>

        <hr style={{ borderColor: '#334155', margin: '20px 0' }} />

        <div style={{ marginBottom: '15px' }}>
          <label
            style={{
              display: 'block',
              marginBottom: '6px',
              fontSize: '0.85rem',
              color: '#94a3b8',
              fontWeight: 500,
            }}
          >
            Have a license code?
          </label>
          <input
            type="text"
            id="blockingCode"
            defaultValue={defaultCode}
            placeholder="Enter license code"
            style={{
              width: '100%',
              padding: '10px',
              borderRadius: '6px',
              border: '1px solid #334155',
              backgroundColor: '#0f172a',
              color: '#f8fafc',
              fontFamily: 'monospace',
              fontSize: '0.95rem',
              boxSizing: 'border-box',
            }}
          />
        </div>

        <button
          className="btn-secondary"
          style={{ width: '100%', padding: '12px', fontSize: '1rem' }}
          onClick={async () => {
            const email = (document.getElementById('blockingEmail') as HTMLInputElement).value;
            const code = (document.getElementById('blockingCode') as HTMLInputElement).value;
            if (!email || !code) {
              alert('Please enter both email and code.');
              return;
            }
            try {
              const newInfo: LicenseInfo = await invoke('activate_license', { email, code });
              alert('License activated successfully!');
              onActivated(newInfo, email, code);
            } catch (err) {
              alert('Failed to activate: ' + err);
            }
          }}
        >
          Activate
        </button>
      </div>
    </div>
  );
};

export default LicenseExpiredDialog;
