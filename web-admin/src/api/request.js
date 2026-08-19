import axios from 'axios';
import { ElMessage } from 'element-plus';

const service = axios.create({
  baseURL: '/_admin/api',
  timeout: 15000,
});

// 全局网关离线状态（由拦截器驱动，Topbar 横幅消费）。
// 懒引用避免 store 与 axios 的循环依赖：Pinia 初始化完成后才可取实例。
let appStoreRef = null;
export function bindAppStore(store) {
  appStoreRef = store;
}

service.interceptors.response.use(
  (response) => {
    // 任何成功响应都意味着网关已恢复
    appStoreRef?.markOnline?.();
    return response.data;
  },
  (error) => {
    const isNetworkError = !error.response;
    const msg = error.response?.data?.error?.message || error.message || '请求失败';

    if (isNetworkError) {
      // 网关不可达（重启窗口 / 进程退出）：置全局离线横幅，不弹 toast 干扰
      appStoreRef?.markOffline?.();
    } else if (!error.config?.skipGlobalError) {
      // 业务/HTTP 错误默认全局提示；视图自管错误态时传 skipGlobalError: true
      ElMessage.error(msg);
    }
    return Promise.reject(error);
  }
);

export default service;
