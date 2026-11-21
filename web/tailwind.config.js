/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#0c0d11',
        surface: '#15171e',
        'surface-highlight': '#1f222d',
        accent: '#6366f1',
        'accent-neon': '#06b6d4',
        'accent-beat': '#10b981',
      },
    },
  },
  plugins: [],
};
