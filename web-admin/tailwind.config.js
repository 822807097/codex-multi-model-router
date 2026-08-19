/**
 * Tailwind CSS 配置
 * 颜色全部引用 styles/tokens.css 中的 RGB 通道变量，
 * 支持透明度修饰符（如 bg-canvas/50），品牌色改动只需编辑 tokens.css。
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js}'],
  theme: {
    extend: {
      colors: {
        // 表面层级
        canvas: 'rgb(var(--bg-canvas-rgb) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--bg-surface-rgb) / <alpha-value>)',
          2: 'rgb(var(--bg-surface-2-rgb) / <alpha-value>)',
        },
        // 边框（border-default / border-muted；bg/text 同名类亦可用）
        default: 'rgb(var(--border-default-rgb) / <alpha-value>)',
        muted: 'rgb(var(--border-muted-rgb) / <alpha-value>)',
        // 品牌与语义色
        accent: {
          DEFAULT: 'rgb(var(--accent-primary-rgb) / <alpha-value>)',
          hover: 'rgb(var(--accent-hover-rgb) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'rgb(var(--success-rgb) / <alpha-value>)',
          text: 'rgb(var(--success-text-rgb) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'rgb(var(--warning-rgb) / <alpha-value>)',
          text: 'rgb(var(--warning-text-rgb) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'rgb(var(--danger-rgb) / <alpha-value>)',
          text: 'rgb(var(--danger-text-rgb) / <alpha-value>)',
        },
        info: {
          text: 'rgb(var(--info-text-rgb) / <alpha-value>)',
        },
        // 平台品牌色（订阅页平台标识）
        brand: {
          claude: 'rgb(var(--brand-claude-rgb) / <alpha-value>)',
          google: 'rgb(var(--brand-google-rgb) / <alpha-value>)',
          openai: 'rgb(var(--brand-openai-rgb) / <alpha-value>)',
        },
        // 图表/分组点缀色（低饱和协调色板）
        chart: {
          1: 'rgb(var(--chart-1-rgb) / <alpha-value>)',
          2: 'rgb(var(--chart-2-rgb) / <alpha-value>)',
          3: 'rgb(var(--chart-3-rgb) / <alpha-value>)',
          4: 'rgb(var(--chart-4-rgb) / <alpha-value>)',
          5: 'rgb(var(--chart-5-rgb) / <alpha-value>)',
          6: 'rgb(var(--chart-6-rgb) / <alpha-value>)',
        },
        // 活跃热力图色阶
        heat: {
          0: 'rgb(var(--heat-0-rgb) / <alpha-value>)',
          1: 'rgb(var(--heat-1-rgb) / <alpha-value>)',
          2: 'rgb(var(--heat-2-rgb) / <alpha-value>)',
          3: 'rgb(var(--heat-3-rgb) / <alpha-value>)',
          4: 'rgb(var(--heat-4-rgb) / <alpha-value>)',
        },
      },
      // preflight 中裸 `border` 类的默认边框色
      borderColor: {
        DEFAULT: 'rgb(var(--border-default-rgb) / <alpha-value>)',
      },
      // 文本色独立命名空间：text-primary / text-regular / text-secondary
      textColor: {
        primary: 'rgb(var(--text-primary-rgb) / <alpha-value>)',
        regular: 'rgb(var(--text-regular-rgb) / <alpha-value>)',
        secondary: 'rgb(var(--text-secondary-rgb) / <alpha-value>)',
      },
      fontSize: {
        // 设计规范字号阶梯中的非标准档
        '2xs': ['11px', { lineHeight: '16px' }],
        '3xs': ['10px', { lineHeight: '14px' }],
      },
      borderRadius: {
        card: '12px',
      },
    },
  },
  plugins: [],
};
