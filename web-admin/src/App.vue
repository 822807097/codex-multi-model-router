<template>
  <el-config-provider>
    <router-view />
  </el-config-provider>
</template>

<script setup>
</script>

<style>
/* 底色与文本色由 styles/main.css 的 body 规则统一接管（引用 tokens.css） */
html, body, #app {
  height: 100%;
  margin: 0;
  padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
}
</style>
