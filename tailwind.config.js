// Colours are design tokens: every palette the UI uses resolves to a CSS custom property holding an
// RGB triplet (src/styles/app.css). The light values equal Tailwind's defaults; `.dark` on <html>
// (set before the first paint by src/js/theme-boot.js) swaps the triplets, so markup and the
// templates in src/js render a real dark theme without per-element dark: variants.
//
// Roles that a plain swap cannot express get their own tokens:
// - `white` as a background is the card surface; as text it stays light (it sits on the dark
//   "inverse" surfaces bg-slate-700 … 950, which stay dark in the dark theme).
// - `scrim` is the backdrop behind dialogs and the mobile drawer; `ink` is text on the brand yellow.

/** @param {string} name */
const token = (name) => `rgb(var(--sp-${name}) / <alpha-value>)`;

const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

/** @param {string} palette */
const scale = (palette) => Object.fromEntries(STEPS.map((step) => [step, token(`${palette}-${step}`)]));

const PALETTES = ['slate', 'amber', 'emerald', 'rose', 'red', 'sky', 'violet', 'indigo'];

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/index.html', './src/js/**/*.js'],
  darkMode: 'class',
  theme: {
    extend: {
      screens: {
        xs: '420px',
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans Variable"', '"Plus Jakarta Sans"', 'Inter', 'sans-serif'],
      },
      colors: {
        ...Object.fromEntries(PALETTES.map((palette) => [palette, scale(palette)])),
        white: token('white'),
        scrim: token('scrim'),
        ink: token('ink'),
        brand: {
          50: '#fffdf0',
          100: '#fef9c3',
          200: '#fef08a',
          300: '#fde047',
          400: '#facc15',
          500: '#ffca00',
          600: '#e5b500',
          700: '#b45309',
          800: '#854d0e',
          900: '#451a03',
        },
        surface: {
          base: token('slate-50'),
          card: token('white'),
          cardHover: token('amber-50'),
          border: token('slate-200'),
          borderHover: token('amber-300'),
          input: token('white'),
        },
      },
      backgroundColor: {
        slate: { 700: token('inverse-700'), 800: token('inverse-800'), 900: token('inverse-900'), 950: token('inverse-950') },
      },
      textColor: {
        white: token('on-inverse'),
      },
      ringColor: {
        white: token('on-inverse'),
      },
      ringOffsetColor: ({ theme }) => theme('backgroundColor'),
      boxShadow: {
        subtle: '0 1px 3px 0 rgba(0, 0, 0, 0.04), 0 1px 2px 0 rgba(0, 0, 0, 0.02)',
        card: '0 4px 20px -2px rgba(15, 23, 42, 0.04), 0 2px 6px -1px rgba(15, 23, 42, 0.02)',
        'card-hover': '0 12px 30px -4px rgba(255, 202, 0, 0.18), 0 4px 12px -2px rgba(15, 23, 42, 0.04)',
        yellow: '0 4px 14px 0 rgba(255, 202, 0, 0.38)',
        'yellow-lg': '0 8px 24px 0 rgba(255, 202, 0, 0.45)',
      },
    },
  },
  plugins: [],
};
