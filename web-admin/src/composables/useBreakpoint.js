import { ref, onMounted, onUnmounted } from 'vue';

/**
 * 响应式断点（与 Tailwind sm/md/lg 对齐）：
 * - isMobile  < 768px：侧栏抽屉化、弹窗近全宽、6 卡 1 列
 * - isCompact < 1280px：侧栏折叠为 64px 图标栏、6 卡 2 列
 */
export function useBreakpoint() {
  const isMobile = ref(false);
  const isCompact = ref(false);

  let mqlMobile = null;
  let mqlCompact = null;

  const onChangeMobile = (e) => { isMobile.value = e.matches; };
  const onChangeCompact = (e) => { isCompact.value = e.matches; };

  onMounted(() => {
    if (typeof window.matchMedia !== 'function') return;
    mqlMobile = window.matchMedia('(max-width: 767.98px)');
    mqlCompact = window.matchMedia('(max-width: 1279.98px)');
    isMobile.value = mqlMobile.matches;
    isCompact.value = mqlCompact.matches;
    mqlMobile.addEventListener('change', onChangeMobile);
    mqlCompact.addEventListener('change', onChangeCompact);
  });

  onUnmounted(() => {
    mqlMobile?.removeEventListener('change', onChangeMobile);
    mqlCompact?.removeEventListener('change', onChangeCompact);
  });

  return { isMobile, isCompact };
}
