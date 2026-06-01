'use client';

import { ChangeEvent, useId, useRef, useState } from 'react';

type Variant = 'card' | 'cover';

type CategoryImageUploaderProps = {
  name: string;
  label: string;
  defaultValue?: string | null;
  variant?: Variant;
  helpText?: string;
};

const ACCEPT = 'image/png,image/jpeg,image/webp';

export function CategoryImageUploader({
  name,
  label,
  defaultValue,
  variant = 'card',
  helpText,
}: CategoryImageUploaderProps) {
  const [url, setUrl] = useState<string>(defaultValue ?? '');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch('/api/uploads/category-image', {
        method: 'POST',
        body: formData,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(extractErrorMessage(text) ?? 'Görsel yüklenemedi');
      }

      const parsed = JSON.parse(text) as { url?: string };
      if (!parsed.url) {
        throw new Error('Sunucu geçerli bir URL döndürmedi');
      }

      setUrl(parsed.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Beklenmeyen hata');
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }

  function handleClear() {
    setUrl('');
    setError(null);
  }

  const previewClass =
    variant === 'cover' ? 'cat-visual-preview-cover' : 'cat-visual-preview-card';

  return (
    <div className="field field-12 cat-uploader">
      <label className="cat-uploader-head" htmlFor={`${inputId}-url`}>
        <span>{label}</span>
      </label>
      <input
        id={`${inputId}-url`}
        name={name}
        type="url"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://cdn.example.com/categories/foo.png"
      />
      <div className="cat-uploader-actions">
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT}
          onChange={handleFileChange}
          disabled={uploading}
          style={{ display: 'none' }}
        />
        <button
          className="btn btn-secondary btn-sm"
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? 'Yükleniyor…' : 'Dosya yükle'}
        </button>
        {url ? (
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            onClick={handleClear}
            disabled={uploading}
          >
            Temizle
          </button>
        ) : null}
        {uploading ? <span className="muted" style={{ fontSize: 12 }}>Yükleniyor…</span> : null}
      </div>
      {error ? <p className="cat-uploader-error">{error}</p> : null}
      <span className="help-text">
        PNG, JPEG veya WebP, en fazla 5 MB. SVG kabul edilmez. Görsel yükleyebilir veya kalıcı
        public URL yapıştırabilirsiniz. Docker / container / tmp / .next gibi geçici path
        kullanmayın.
        {helpText ? <> {helpText}</> : null}
      </span>
      {url ? (
        <img
          src={url}
          alt={`${label} önizleme`}
          className={previewClass}
          onError={() => setError('Görsel yüklenemedi (URL erişilemiyor olabilir).')}
        />
      ) : null}
    </div>
  );
}

function extractErrorMessage(text: string): string | null {
  if (!text) return null;
  try {
    const json = JSON.parse(text) as { message?: string | string[] };
    if (Array.isArray(json.message)) {
      return json.message.join(', ');
    }
    return json.message ?? null;
  } catch {
    return text.slice(0, 200);
  }
}
