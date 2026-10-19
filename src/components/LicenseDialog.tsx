import React, { useState } from 'react';
import { ShieldCheck, Copy, Check, ExternalLink, X, KeyRound, Mail, Monitor } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { LicenseInfo } from '../App';

interface LicenseDialogProps {
  isOpen: boolean;
  onClose: () => void;
  licenseInfo: LicenseInfo | null;
  defaultEmail?: string;
  defaultCode?: string;
  onActivate: (newInfo: LicenseInfo, email: string, code: string) => void;
}

export const LicenseDialog: React.FC<LicenseDialogProps> = ({
  isOpen,
  onClose,
  licenseInfo,
  defaultEmail = '',
  defaultCode = '',
  onActivate,
}) => {
  const [email, setEmail] = useState(defaultEmail);
  const [code, setCode] = useState(defaultCode);
  const [copied, setCopied] = useState(false);
  const [activating, setActivating] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  if (!isOpen) return null;

  const handleCopyDeviceId = () => {
    if (licenseInfo?.device_id) {
      navigator.clipboard.writeText(licenseInfo.device_id);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleBuyLicense = async () => {
    if (!email) {
      setFeedback({ type: 'error', message: 'Please enter your email address first.' });
      return;
    }
    try {
      const webAppUrl = await invoke<string>('get_web_app_url');
      const url = `${webAppUrl}?email=${encodeURIComponent(email)}&deviceId=${encodeURIComponent(
        licenseInfo?.device_id || ''
      )}`;
      await openUrl(url);
    } catch (e: any) {
      setFeedback({ type: 'error', message: `Failed to open store: ${e?.message || e}` });
    }
  };

  const handleActivate = async () => {
    if (!email.trim() || !code.trim()) {
      setFeedback({ type: 'error', message: 'Please enter both your email address and license code.' });
      return;
    }
    setActivating(true);
    setFeedback(null);
    try {
      const newInfo: LicenseInfo = await invoke('activate_license', { email: email.trim(), code: code.trim() });
      setFeedback({ type: 'success', message: 'License activated successfully!' });
      onActivate(newInfo, email.trim(), code.trim());
    } catch (err: any) {
      setFeedback({ type: 'error', message: `Activation failed: ${err?.message || err}` });
    } finally {
      setActivating(false);
    }
  };

  // Status Badge Helper
  const renderStatusBadge = () => {
    if (!licenseInfo) return <span style={{ color: '#94a3b8' }}>Checking...</span>;

    const { status } = licenseInfo;
    if (status === 'Expired') {
      return (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            backgroundColor: 'rgba(239, 68, 68, 0.15)',
            color: '#f87171',
            padding: '4px 10px',
            borderRadius: '6px',
            fontWeight: 600,
            fontSize: '0.85rem',
            border: '1px solid rgba(239, 68, 68, 0.3)',
          }}
        >
          ● Expired
        </span>
      );
    }

    if (typeof status === 'object' && 'Trial' in status) {
      return (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            backgroundColor: 'rgba(245, 158, 11, 0.15)',
            color: '#fbbf24',
            padding: '4px 10px',
            borderRadius: '6px',
            fontWeight: 600,
            fontSize: '0.85rem',
            border: '1px solid rgba(245, 158, 11, 0.3)',
          }}
        >
          ● Trial Mode ({status.Trial.days_left} days left)
        </span>
      );
    }

    if (typeof status === 'object' && 'Activated' in status) {
      const isPermanent = status.Activated.expiry_date >= 4000000000;
      const expiryStr = isPermanent
        ? 'Permanent'
        : `Expires ${new Date(status.Activated.expiry_date * 1000).toLocaleDateString()}`;

      return (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            backgroundColor: 'rgba(16, 185, 129, 0.15)',
            color: '#34d399',
            padding: '4px 10px',
            borderRadius: '6px',
            fontWeight: 600,
            fontSize: '0.85rem',
            border: '1px solid rgba(16, 185, 129, 0.3)',
          }}
        >
          ● Activated ({expiryStr})
        </span>
      );
    }

    return null;
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(10, 15, 29, 0.75)',
        backdropFilter: 'blur(10px)',
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'fadeIn 0.2s ease',
        padding: '20px',
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '480px',
          backgroundColor: '#0f172a',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: '14px',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.8), 0 0 24px rgba(56, 189, 248, 0.15)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          color: '#f8fafc',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            background: 'rgba(17, 24, 39, 0.6)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                backgroundColor: 'rgba(56, 189, 248, 0.15)',
                color: '#38bdf8',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ShieldCheck size={18} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600, color: '#f1f5f9' }}>
                License & Activation
              </h3>
              <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Manage MHZipy subscription & device registration</span>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              padding: '6px',
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
          {/* Status Card */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 16px',
              backgroundColor: 'rgba(30, 41, 59, 0.7)',
              borderRadius: '10px',
              border: '1px solid rgba(255, 255, 255, 0.06)',
            }}
          >
            <span style={{ fontSize: '0.85rem', color: '#cbd5e1', fontWeight: 500 }}>Current Status</span>
            {renderStatusBadge()}
          </div>

          {/* Feedback message */}
          {feedback && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: '8px',
                fontSize: '0.85rem',
                backgroundColor: feedback.type === 'success' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                color: feedback.type === 'success' ? '#34d399' : '#f87171',
                border: `1px solid ${feedback.type === 'success' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
              }}
            >
              {feedback.message}
            </div>
          )}

          {/* Device ID */}
          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '6px', fontWeight: 500 }}>
              <Monitor size={14} /> Device Hardware ID
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                readOnly
                value={licenseInfo?.device_id || ''}
                style={{
                  flex: 1,
                  padding: '9px 12px',
                  backgroundColor: 'rgba(15, 23, 42, 0.8)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '6px',
                  color: '#94a3b8',
                  fontSize: '0.85rem',
                  fontFamily: 'monospace',
                }}
              />
              <button
                type="button"
                onClick={handleCopyDeviceId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '9px 14px',
                  backgroundColor: copied ? 'rgba(16, 185, 129, 0.2)' : 'rgba(255, 255, 255, 0.08)',
                  color: copied ? '#34d399' : '#e2e8f0',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '0.82rem',
                  fontWeight: 500,
                  transition: 'all 0.15s ease',
                }}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <span style={{ fontSize: '0.72rem', color: '#64748b', marginTop: '4px', display: 'block' }}>
              Used to bind license keys to your current computer hardware.
            </span>
          </div>

          <hr style={{ borderColor: 'rgba(255, 255, 255, 0.08)', margin: '2px 0' }} />

          {/* Email Address & Buy License */}
          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '6px', fontWeight: 500 }}>
              <Mail size={14} /> Email Address
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="email"
                placeholder="name@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={{
                  flex: 1,
                  padding: '9px 12px',
                  backgroundColor: 'rgba(15, 23, 42, 0.8)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: '6px',
                  color: '#f8fafc',
                  fontSize: '0.88rem',
                }}
              />
              <button
                type="button"
                onClick={handleBuyLicense}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '9px 14px',
                  background: 'linear-gradient(135deg, #0284c7 0%, #2563eb 100%)',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}
              >
                <ExternalLink size={14} />
                Buy License
              </button>
            </div>
          </div>

          {/* License Code & Activate */}
          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '6px', fontWeight: 500 }}>
              <KeyRound size={14} /> License Code
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                placeholder="Enter your activation license code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                style={{
                  flex: 1,
                  padding: '9px 12px',
                  backgroundColor: 'rgba(15, 23, 42, 0.8)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: '6px',
                  color: '#f8fafc',
                  fontSize: '0.88rem',
                  fontFamily: 'monospace',
                }}
              />
              <button
                type="button"
                onClick={handleActivate}
                disabled={activating}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '9px 18px',
                  backgroundColor: '#38bdf8',
                  color: '#0f172a',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: activating ? 'not-allowed' : 'pointer',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  opacity: activating ? 0.6 : 1,
                }}
              >
                {activating ? 'Activating...' : 'Activate'}
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '12px 20px',
            backgroundColor: 'rgba(17, 24, 39, 0.5)',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '7px 18px',
              backgroundColor: 'rgba(255, 255, 255, 0.08)',
              color: '#e2e8f0',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '0.85rem',
              fontWeight: 500,
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default LicenseDialog;
