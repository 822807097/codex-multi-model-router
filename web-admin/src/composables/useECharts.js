import { onUnmounted, watch } from 'vue';
import * as echarts from 'echarts';

/**
 * ECharts 生命周期组合式函数：
 * - init 幂等（重复调用复用实例）
 * - ResizeObserver 随容器自适应（替代 window resize 监听）
 * - 组件卸载自动 dispose + 断开观察器，杜绝实例泄漏
 *
 * @param {import('vue').Ref<HTMLElement|null>} elRef 图表容器 ref
 * @returns {{ setOption(option: object, opts?: object): void, resize(): void, dispose(): void, getInstance(): echarts.ECharts|null }}
 */
export function useECharts(elRef) {
  let instance = null;
  let observer = null;

  function ensureInstance() {
    if (instance || !elRef.value) return instance;
    instance = echarts.init(elRef.value);
    observer = new ResizeObserver(() => instance?.resize());
    observer.observe(elRef.value);
    return instance;
  }

  function setOption(option, opts) {
    const chart = ensureInstance();
    chart?.setOption(option, opts);
  }

  function resize() {
    instance?.resize();
  }

  function dispose() {
    observer?.disconnect();
    observer = null;
    if (instance) {
      instance.dispose();
      instance = null;
    }
  }

  onUnmounted(dispose);

  // 容器 ref 晚挂载（v-if 数据区就绪后才渲染图表容器）时自动补初始化
  if (elRef) {
    watch(elRef, (el) => {
      if (el && !instance) ensureInstance();
    });
  }

  return { setOption, resize, dispose, getInstance: () => instance };
}

/**
 * 从 tokens.css 读取 CSS 变量计算值（ECharts canvas 无法直接消费 var()）。
 */
export function cssVar(name, fallback = '') {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * 模型系列统一色板：按索引循环取 --chart-1..6 Token。
 */
export function chartColorByIndex(index) {
  const palette = [1, 2, 3, 4, 5, 6].map((n) => cssVar(`--chart-${n}`, '#6fa9e0'));
  return palette[index % palette.length];
}
