import type { Config } from 'tailwindcss';
import redstyle from '@redbtn/redstyle/preset';

const config: Config = {
  presets: [redstyle],
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    './node_modules/@redbtn/redstyle/dist/**/*.{js,mjs}',
  ],
};

export default config;
