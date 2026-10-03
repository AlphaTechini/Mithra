<script lang="ts" module>
  /** Inline icon paths on a 24 px grid, drawn as 1.75 px strokes. No icon font, no CDN. */
  export const ICONS = {
    check: 'M5 12.5l4.5 4.5L19 7.5',
    'check-circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.5l2.7 2.7L16 9.5',
    'check-double': 'M2.5 12.5L7 17l8-9.5M11 15.5l1.5 1.5 9-9.5',
    hourglass:
      'M7 3h10M7 21h10M8 3v3.5a4 4 0 0 0 1.6 3.2L12 12l2.4-2.3A4 4 0 0 0 16 6.5V3M8 21v-3.5a4 4 0 0 1 1.6-3.2L12 12l2.4 2.3A4 4 0 0 1 16 17.5V21',
    mail: 'M4 6h16v12H4zM4 7l8 6 8-6',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
    'x-circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 9l6 6M15 9l-6 6',
    x: 'M6 6l12 12M18 6L6 18',
    ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.6 5.6l12.8 12.8',
    flag: 'M5 21V4M5 4h12l-2 4 2 4H5',
    shield: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6zM9 12l2.2 2.2L15.5 10',
    key: 'M14.5 9.5a4 4 0 1 1-7 0 4 4 0 0 1 7 0zM11 13v8M11 17h3M11 20h2',
    'key-off': 'M14.5 9.5a4 4 0 1 1-7 0 4 4 0 0 1 7 0zM11 13v8M11 17h3M3 3l18 18',
    tag: 'M3 12V4h8l10 10-8 8zM7.5 7.5h.01',
    copy: 'M9 9h11v11H9zM5 15V4h11',
    alert: 'M12 3l10 18H2zM12 10v5M12 18h.01',
    'chevron-down': 'M6 9l6 6 6-6',
    flask: 'M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2.2h12.4a1.5 1.5 0 0 0 1.3-2.2L14 9V3M7.5 15h9',
    globe:
      'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9S14.5 18.5 12 21c-2.5-2.5-3.5-5.5-3.5-9S9.5 5.5 12 3z',
    home: 'M4 11l8-7 8 7M6 10v10h12V10',
    inbox: 'M4 13l2-8h12l2 8M4 13v6h16v-6M4 13h5l1 2h4l1-2h5',
    sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 17v4M17 19h4',
    cycle: 'M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3M18 3v4h-4M6 21v-4h4',
    users:
      'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14a6.5 6.5 0 0 1 3.5 6',
    audit: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5',
    activity: 'M3 12h4l3-8 4 16 3-8h4',
    settings:
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.5-2.3 1a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.6a7 7 0 0 0-2 1.2l-2.3-1-2 3.5 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.5 2.3-1a7 7 0 0 0 2 1.2L10 21h4l.6-2.6a7 7 0 0 0 2-1.2l2.3 1 2-3.5-2-1.5c.1-.4.1-.8.1-1.2z',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    send: 'M4 12l16-8-6 16-3-6.5z',
    spinner: 'M12 3a9 9 0 1 0 9 9',
    dot: 'M12 12h.01',
    plus: 'M12 5v14M5 12h14',
    external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
    pause: 'M8 5v14M16 5v14',
    play: 'M7 4l13 8-13 8z',
    server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
    wallet:
      'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7V6a2 2 0 0 1 2-2h11M16.5 14h.01',
    wifi: 'M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01',
    'wifi-off':
      'M2 9a15 15 0 0 1 5-3M5 12.5a10 10 0 0 1 3-2M8.5 16a5 5 0 0 1 7 0M12 19.5h.01M3 3l18 18',
    sealed: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12.5l3 3 5-6',
  } as const;

  export type IconName = keyof typeof ICONS;
</script>

<script lang="ts">
  /** Decorative icon (always paired with text), hidden from assistive technology. */
  let {
    name,
    size = 16,
    spin = false,
  }: { name: IconName; size?: number; spin?: boolean } = $props();
</script>

<svg
  class="icon"
  class:spin
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
  data-icon={name}
>
  <path d={ICONS[name]} />
</svg>

<style>
  .icon {
    flex: none;
    display: inline-block;
    vertical-align: middle;
  }
  .spin {
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
