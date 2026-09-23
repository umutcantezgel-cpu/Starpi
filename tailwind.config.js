/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/index.html', './src/js/**/*.js'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans Variable"', '"Plus Jakarta Sans"', 'Inter', 'sans-serif'],
      },
      colors: {
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
          base: '#f8fafc',
          card: '#ffffff',
          cardHover: '#fefce8',
          border: '#e2e8f0',
          borderHover: '#fcd34d',
          input: '#ffffff',
        },
      },
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
