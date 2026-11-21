/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: process.env.NEXT_EXPORT ? 'export' : undefined,
  // Keep export builds out of the dev server's .next folder
  distDir: process.env.NEXT_EXPORT ? '.next-export' : '.next',
  images: {
    unoptimized: true,
  },
};

module.exports = nextConfig;
