/** The browser talks to /api on the same origin; Next proxies it to the NestJS service (no CORS, token never leaves the origin). */
const api = process.env.API_URL ?? 'http://localhost:4000';
export default {
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${api}/api/:path*` }];
  },
  poweredByHeader: false,
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'same-origin' },
      ],
    }];
  },
};
