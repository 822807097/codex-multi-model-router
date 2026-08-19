import { createRouter, createWebHashHistory } from 'vue-router';
import Layout from '../layout/Index.vue';

const routes = [
  {
    path: '/',
    component: Layout,
    redirect: '/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('../views/dashboard/Index.vue'),
        meta: { title: '使用统计', icon: 'DataAnalysis' },
      },
      {
        path: 'models',
        name: 'Models',
        component: () => import('../views/models/Index.vue'),
        meta: { title: '分组自定义模型', icon: 'FolderOpened' },
      },
      {
        path: 'subscriptions',
        name: 'Subscriptions',
        component: () => import('../views/subscriptions/Index.vue'),
        meta: { title: '平台会员订阅授权', icon: 'Key' },
      },
      {
        path: 'keys',
        name: 'Keys',
        component: () => import('../views/keys/Index.vue'),
        meta: { title: 'API 密钥管理', icon: 'Lock' },
      },
      {
        path: 'settings',
        name: 'Settings',
        component: () => import('../views/settings/Index.vue'),
        meta: { title: '系统与路由配置', icon: 'Setting' },
      },
    ],
  },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

export default router;
