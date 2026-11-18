<script setup lang="ts">
const user = useSupabaseUser();
const { packReady } = usePackSignal();
</script>

<template>
  <div class="shell">
    <slot />

    <nav v-if="user" class="nav" aria-label="Main">
      <NuxtLink to="/pack">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h18v3H3zM4 11h16v9H4zm6 0h4v9h-4z"/></svg>
        Pack
        <span v-if="packReady" class="nav__dot" aria-hidden="true" />
      </NuxtLink>
      <NuxtLink to="/collection">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h7v8H4zm9 0h7v5h-7zM4 13h7v8H4zm9-3h7v11h-7z"/></svg>
        Collection
      </NuxtLink>
      <NuxtLink to="/profile">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0 2c-4.4 0-8 2.5-8 5.5V21h16v-1.5c0-3-3.6-5.5-8-5.5Z"/></svg>
        Profile
      </NuxtLink>
    </nav>
  </div>
</template>
