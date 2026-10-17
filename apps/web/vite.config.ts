import { defineConfig } from 'vite';

const port = (value: string | undefined, fallback: number) => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535)
    throw new Error('Invalid local service port');
  return parsed;
};
export default defineConfig(({ mode }) => {
  const webPort = port(process.env.AUTHCORE_WEB_PORT, 3000);
  const apiPort = port(process.env.AUTHCORE_API_PORT, 4000);
  const development = mode !== 'production';
  const headers = {
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'" + (development ? " 'unsafe-inline'" : ''),
      "connect-src 'self'" + (development ? ' ws://127.0.0.1:' + webPort : ''),
      "img-src 'self' data:",
      "font-src 'self'",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  };
  return {
    server: {
      host: '127.0.0.1',
      port: webPort,
      strictPort: true,
      headers,
      proxy: { '/api': { target: 'http://127.0.0.1:' + apiPort, changeOrigin: false } },
    },
    preview: { host: '127.0.0.1', port: webPort, strictPort: true, headers },
    build: { sourcemap: false },
  };
});
