/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: process.env.NEXT_EXPORT ? 'export' : undefined,
  // Export builds go to web/out (Firebase Hosting's folder), never the dev server's .next
  distDir: process.env.NEXT_EXPORT ? '.next-export' : '.next',
  images: {
    unoptimized: true,
  },
};

module.exports = nextConfig;
