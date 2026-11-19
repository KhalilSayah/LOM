<script setup lang="ts">
const user = useSupabaseUser();
const { packReady } = usePackSignal();

// A challenge arrives without you doing anything, so the nav has to say so.
const { incoming, drafting, start } = useDuelSignal();
watch(user, (u) => { if (u) start(); }, { immediate: true });
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
        Cards
      </NuxtLink>
      <NuxtLink to="/roster">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3.2 3.2 0 1 0 0 6.4A3.2 3.2 0 0 0 12 3ZM5 10.5a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Zm14 0a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2ZM12 11c-2.9 0-5.2 1.7-5.2 3.8V21h10.4v-6.2c0-2.1-2.3-3.8-5.2-3.8ZM5 12c-2.2 0-4 1.3-4 3V21h3.8v-6.2c0-1 .4-2 1.1-2.7A5 5 0 0 0 5 12Zm14 0c-.3 0-.6 0-.9.1.7.7 1.1 1.7 1.1 2.7V21H23v-6c0-1.7-1.8-3-4-3Z"/></svg>
        Roster
      </NuxtLink>
      <NuxtLink to="/discovery">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm3.9 6.1-2.2 5-5 2.2 2.2-5 5-2.2ZM12 11a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"/></svg>
        Discover
      </NuxtLink>
      <NuxtLink to="/duels">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.9 3 3 6.9l9.1 9.1 1.4-1.4-1.1-1.1 1.4-1.4 1.1 1.1 1.4-1.4L6.9 3Zm10.2 0L13 7.1l1.4 1.4 1.1-1.1 1.4 1.4-1.1 1.1 1.4 1.4L21 6.9 17.1 3ZM4.5 17.1 3 18.6 5.4 21l1.5-1.5-2.4-2.4Zm15 0-2.4 2.4L18.6 21 21 18.6l-1.5-1.5Z"/></svg>
        Duels
        <span v-if="incoming || drafting" class="nav__count" aria-hidden="true">{{ incoming || drafting }}</span>
      </NuxtLink>
      <NuxtLink to="/profile">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0 2c-4.4 0-8 2.5-8 5.5V21h16v-1.5c0-3-3.6-5.5-8-5.5Z"/></svg>
        Profile
      </NuxtLink>
    </nav>
  </div>
</template>
