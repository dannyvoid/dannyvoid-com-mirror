(function() {
  'use strict';

  // ============================================
  // SHARED NARROW LAYOUT
  // One detector drives masthead + now-playing compact chrome.
  // Triggers when full chrome would collide / wrap - not a fixed px guess.
  // ============================================
  const NARROW_LAYOUT_FLOOR_MQ = '(max-width: 768px)';
  const narrowLayoutFloorMq = window.matchMedia(NARROW_LAYOUT_FLOOR_MQ);
  let narrowLayoutActive = false;
  let narrowLayoutRaf = 0;

  function rectsOverlap(a, b, pad) {
    const p = pad || 0;
    return !(
      a.right + p <= b.left ||
      a.left >= b.right + p ||
      a.bottom + p <= b.top ||
      a.top >= b.bottom + p
    );
  }

  // Block boxes are full content-width; only glyph boxes are meaningful for overlap.
  function nodeTextOverlapsRect(node, targetRect, pad) {
    if (!node || !node.textContent || !node.textContent.trim()) return false;
    const range = document.createRange();
    range.selectNodeContents(node);
    const textRects = range.getClientRects();
    for (let i = 0; i < textRects.length; i++) {
      const r = textRects[i];
      if (r.width < 1 || r.height < 1) continue;
      if (rectsOverlap(r, targetRect, pad)) return true;
    }
    return false;
  }

  function isMastheadCramped(minGap) {
    const logo = document.querySelector('.logo-section');
    const nav = document.querySelector('.main-nav');
    const localTime = document.querySelector('.local-time');
    if (!logo || !nav) return false;

    const logoRect = logo.getBoundingClientRect();
    const navRect = nav.getBoundingClientRect();
    // Ignore pre-layout / zero-size frames
    if (logoRect.width < 2 || navRect.width < 2) return false;

    const gap = navRect.left - logoRect.right;
    if (gap < minGap) return true;

    if (localTime && localTime.getClientRects().length) {
      // nowrap: multi-line client rects mean Houston wrapped
      if (localTime.getClientRects().length > 1) return true;
      const label = localTime.querySelector('.time-label');
      if (label && label.getClientRects().length > 1) return true;
    }

    return false;
  }

  function isNowPlayingCramped() {
    const card = document.querySelector('.now-playing-card:not(.error)');
    const aside = card && card.querySelector('.now-playing-aside');
    if (!card || !aside) return false;

    const asideRect = aside.getBoundingClientRect();
    if (asideRect.width < 2 || asideRect.height < 2) return false;

    // Only collide against visible aside meta
    const hasAsideMeta = Array.prototype.some.call(
      aside.querySelectorAll('.now-playing-plays, .now-playing-lifetime'),
      (el) => !el.hasAttribute('hidden') && el.textContent.trim()
    );
    if (!hasAsideMeta) return false;

    const pad = 10;
    const album = card.querySelector('.track-album:not([hidden])');
    if (nodeTextOverlapsRect(album, asideRect, pad)) return true;

    const artist = card.querySelector('.track-artist');
    if (nodeTextOverlapsRect(artist, asideRect, pad)) return true;

    const trackName = card.querySelector('.track-name');
    if (nodeTextOverlapsRect(trackName, asideRect, pad)) return true;

    return false;
  }

  function syncNarrowLayout() {
    const root = document.documentElement;
    // Measure against full chrome in the same frame (no paint between remove + restore)
    root.classList.remove('is-narrow-layout');

    // Hysteresis: need more breathing room to exit compact than to enter
    const minGap = narrowLayoutActive ? 40 : 24;
    const needsNarrow =
      narrowLayoutFloorMq.matches ||
      isMastheadCramped(minGap) ||
      isNowPlayingCramped();

    narrowLayoutActive = needsNarrow;
    root.classList.toggle('is-narrow-layout', needsNarrow);
  }

  function scheduleNarrowLayoutSync() {
    if (narrowLayoutRaf) return;
    narrowLayoutRaf = requestAnimationFrame(() => {
      narrowLayoutRaf = 0;
      syncNarrowLayout();
    });
  }

  syncNarrowLayout();
  window.addEventListener('resize', scheduleNarrowLayoutSync);
  if (typeof narrowLayoutFloorMq.addEventListener === 'function') {
    narrowLayoutFloorMq.addEventListener('change', scheduleNarrowLayoutSync);
  } else if (typeof narrowLayoutFloorMq.addListener === 'function') {
    narrowLayoutFloorMq.addListener(scheduleNarrowLayoutSync);
  }
  document.addEventListener('now-playing:updated', scheduleNarrowLayoutSync);
  document.addEventListener('now-playing:art-updated', scheduleNarrowLayoutSync);

  if (typeof ResizeObserver === 'function') {
    const narrowLayoutRo = new ResizeObserver(scheduleNarrowLayoutSync);
    const observeNarrowTargets = () => {
      const masthead = document.querySelector('.masthead-inner');
      const nowPlaying = document.querySelector('.now-playing-widget');
      if (masthead) narrowLayoutRo.observe(masthead);
      if (nowPlaying) narrowLayoutRo.observe(nowPlaying);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', observeNarrowTargets, { once: true });
    } else {
      observeNarrowTargets();
    }
  }

  // ============================================
  // HOVER SOUND EFFECT
  // ============================================
  
  const hoverSound = new Audio('assets/branding/hover.mp3');
  hoverSound.volume = 0.8; // Adjust volume (0.0 to 1.0)
  let soundReady = false;
  let soundEnabled = false; // Default to OFF
  
  // Check localStorage for saved preference
  const savedPreference = localStorage.getItem('soundEnabled');
  if (savedPreference !== null) {
    soundEnabled = savedPreference === 'true';
  }
  
  // Preload the sound
  hoverSound.addEventListener('canplaythrough', () => {
    soundReady = true;
  }, { once: true });
  
  // Load the sound
  hoverSound.load();
  
  // Function to play hover sound with debounce
  let lastPlayTime = 0;
  const minDelay = 100; // Minimum 100ms between sounds
  
  function playHoverSound() {
    if (!soundEnabled) return; // Don't play if sound is disabled
    
    const now = Date.now();
    if (soundReady && (now - lastPlayTime) > minDelay) {
      hoverSound.currentTime = 0;
      hoverSound.play().catch((error) => {
        console.debug('Audio play prevented:', error.message);
      });
      lastPlayTime = now;
    }
  }
  
  // Toggle sound function
  function toggleSound() {
    soundEnabled = !soundEnabled;
    localStorage.setItem('soundEnabled', soundEnabled);
    updateSoundToggleUI();
    
    // Play a test sound when enabling
    if (soundEnabled) {
      playHoverSound();
    }
  }
  
  // Update UI to reflect sound state
  function updateSoundToggleUI() {
    const toggle = document.getElementById('sound-toggle');
    if (toggle) {
      if (soundEnabled) {
        toggle.classList.add('sound-enabled');
        toggle.classList.remove('sound-disabled');
        toggle.setAttribute('aria-pressed', 'true');
        toggle.setAttribute('aria-label', 'Mute');
        toggle.setAttribute('title', 'Mute');
      } else {
        toggle.classList.add('sound-disabled');
        toggle.classList.remove('sound-enabled');
        toggle.setAttribute('aria-pressed', 'false');
        toggle.setAttribute('aria-label', 'Unmute');
        toggle.setAttribute('title', 'Unmute');
      }
    }
  }
  
  // Initialize sound toggle button
  const soundToggle = document.getElementById('sound-toggle');
  if (soundToggle) {
    soundToggle.addEventListener('click', toggleSound);
    updateSoundToggleUI(); // Set initial state
  }

  // Header email: click to copy (text remains selectable)
  document.querySelectorAll('[data-copy-email]').forEach((el) => {
    el.addEventListener('click', async (e) => {
      // Let intentional text selections stay put
      const selection = window.getSelection && window.getSelection();
      if (selection && selection.type === 'Range' && el.contains(selection.anchorNode)) {
        return;
      }

      const email = el.getAttribute('data-copy-email') || el.textContent.trim();
      if (!email) return;

      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(email);
        } else {
          const range = document.createRange();
          range.selectNodeContents(el);
          selection.removeAllRanges();
          selection.addRange(range);
          document.execCommand('copy');
          selection.removeAllRanges();
        }

        const label = el.querySelector('span') || el;
        const original = label.textContent;
        el.classList.add('is-copied');
        label.textContent = 'Copied';
        el.setAttribute('aria-label', 'Email copied');
        window.setTimeout(() => {
          el.classList.remove('is-copied');
          label.textContent = original;
          el.setAttribute('aria-label', 'Copy email address ' + email);
        }, 1200);
      } catch (err) {
        console.debug('Clipboard copy failed:', err && err.message ? err.message : err);
      }
    });
  });
  
  // Use event delegation for hover sounds (works with dynamically added elements)
  document.addEventListener('mouseenter', (e) => {
    // Check if target is a valid Element before using closest
    if (e.target && e.target.nodeType === 1 && e.target.closest && e.target.closest('[data-sound-hover]')) {
      playHoverSound();
    }
  }, true); // Use capture phase to catch all events

  // ============================================
  // DYNAMIC PORTFOLIO RANDOMIZATION
  // ============================================
  
  const portfolioImages = [
    { src: 'assets/album-art/201.webp', number: '201' },
    { src: 'assets/album-art/321.webp', number: '321' },
    { src: 'assets/album-art/382.webp', number: '382' },
    { src: 'assets/album-art/434.webp', number: '434' },
    { src: 'assets/album-art/636.webp', number: '636' },
    { src: 'assets/album-art/787.webp', number: '787' }
  ];

  // Shuffle array function
  function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  // Generate portfolio grid
  function generatePortfolio() {
    const grid = document.getElementById('portfolio-grid');
    if (!grid) return;

    const shuffled = shuffleArray(portfolioImages);
    
    // Layout patterns: index 0 and 3 will be "large" items for visual interest
    const largeIndices = [0, 3];
    
    shuffled.forEach((img, index) => {
      const isLarge = largeIndices.includes(index);
      const item = document.createElement('a');
      item.href = '#';
      item.className = `portfolio-item${isLarge ? ' large' : ''} fade-in`;
      item.setAttribute('data-lightbox', 'gallery');
      item.setAttribute('data-sound-hover', '');
      item.style.transitionDelay = `${index * 0.05}s`;
      
      const media = document.createElement('div');
      media.className = 'portfolio-item-media';

      const image = document.createElement('img');
      image.src = img.src;
      image.alt = `Album artwork #${img.number}`;
      image.width = 1200;
      image.height = 1200;
      image.loading = 'lazy';
      image.crossOrigin = 'anonymous';
      image.decoding = 'async';

      const canvas = document.createElement('canvas');
      canvas.className = 'portfolio-dither-canvas';
      canvas.setAttribute('aria-hidden', 'true');

      media.appendChild(image);
      media.appendChild(canvas);

      const overlay = document.createElement('div');
      overlay.className = 'item-overlay';
      overlay.innerHTML = `<span class="item-number">#${img.number}</span>`;

      item.appendChild(media);
      item.appendChild(overlay);
      grid.appendChild(item);
      initPortfolioDither(item);
    });
  }

  // ============================================
  // PORTFOLIO DITHER EFFECT
  // ============================================

  const BAYER_4X4 = [
    0, 8, 2, 10,
    12, 4, 14, 6,
    3, 11, 1, 9,
    15, 7, 13, 5
  ];

  const DITHER_LEVELS = 5; // per-channel steps - lower = chunkier dither, keeps original hues
  const DITHER_STEP = 255 / (DITHER_LEVELS - 1);

  // Fast ordered dither that preserves original colors.
  // Writes into destData from srcData (same buffer OK if strength handling copies first).
  function ditherImageDataFast(destData, srcData, width, height, time, mouseX, mouseY, strength) {
    const len = destData.length;
    if (destData !== srcData) destData.set(srcData);

    const phaseShift = ((time * 0.012) + (mouseX * 12) + (mouseY * 7)) | 0;
    const blend = strength;
    const invBlend = 1 - blend;
    const step = DITHER_STEP;
    const invStep = 1 / step;
    const maxLevel = DITHER_LEVELS - 1;

    for (let i = 0, p = 0; i < len; i += 4, p++) {
      const x = p % width;
      const y = (p / width) | 0;
      const bayer = (BAYER_4X4[((y & 3) * 4) + ((x + phaseShift) & 3)] + 0.5) * 0.0625;
      const bias = (bayer - 0.5) * step;

      const r = srcData[i];
      const g = srcData[i + 1];
      const b = srcData[i + 2];

      let qr = ((r + bias) * invStep + 0.5) | 0;
      let qg = ((g + bias) * invStep + 0.5) | 0;
      let qb = ((b + bias) * invStep + 0.5) | 0;
      if (qr < 0) qr = 0; else if (qr > maxLevel) qr = maxLevel;
      if (qg < 0) qg = 0; else if (qg > maxLevel) qg = maxLevel;
      if (qb < 0) qb = 0; else if (qb > maxLevel) qb = maxLevel;

      destData[i] = r * invBlend + qr * step * blend;
      destData[i + 1] = g * invBlend + qg * step * blend;
      destData[i + 2] = b * invBlend + qb * step * blend;
    }
  }

  function ditherImageData(imageData, time, mouseX, mouseY, strength) {
    const src = new Uint8ClampedArray(imageData.data);
    ditherImageDataFast(imageData.data, src, imageData.width, imageData.height, time, mouseX, mouseY, strength);
  }

  function drawImageCover(ctx, img, destW, destH) {
    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    if (!srcW || !srcH) return;

    const scale = Math.max(destW / srcW, destH / srcH);
    const drawW = srcW * scale;
    const drawH = srcH * scale;
    const dx = (destW - drawW) / 2;
    const dy = (destH - drawH) / 2;
    ctx.drawImage(img, dx, dy, drawW, drawH);
  }

  // Shared image dither controller - same chunky Bayer look as portfolio hover.
  function createImageDitherController(config) {
    const {
      host,
      img,
      canvas,
      renderScale = 0.22,
      ditherFrameSkip = 2,
      cover = false,
      getTargetStrength = () => 0,
      onStrengthChange
    } = config;

    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    const offscreen = document.createElement('canvas');
    const offCtx = offscreen.getContext('2d', { willReadFrequently: true, alpha: false });

    let strength = 0;
    let mouse = { x: 0.5, y: 0.5 };
    let rafId = null;
    let imageReady = false;
    let decoding = false;
    let renderW = 0;
    let renderH = 0;
    let basePixels = null;
    let workImageData = null;
    let frameCount = 0;
    let needsBaseRebuild = true;
    let disabled = false;
    let hasValidFrame = false;
    let paused = false;

    function markReady() {
      if (!img.naturalWidth) return false;
      imageReady = true;
      needsBaseRebuild = true;
      disabled = false;
      return true;
    }

    function ensureImageReady() {
      if (imageReady || markReady()) return Promise.resolve(true);
      if (decoding) return Promise.resolve(false);

      decoding = true;
      const ready = img.decode
        ? img.decode().then(() => markReady()).catch(() => markReady())
        : new Promise((resolve) => {
            const onLoad = () => { cleanup(); resolve(markReady()); };
            const onError = () => { cleanup(); resolve(false); };
            const cleanup = () => {
              img.removeEventListener('load', onLoad);
              img.removeEventListener('error', onError);
            };
            img.addEventListener('load', onLoad, { once: true });
            img.addEventListener('error', onError, { once: true });
            if (img.complete) onLoad();
          });

      return ready.finally(() => { decoding = false; });
    }

    function rebuildBase() {
      if (!img.naturalWidth || !img.naturalHeight) return false;

      const rect = host.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;

      const nextW = Math.max(1, Math.round(rect.width * renderScale));
      const nextH = Math.max(1, Math.round(rect.height * renderScale));

      if (nextW !== renderW || nextH !== renderH || !basePixels) {
        renderW = nextW;
        renderH = nextH;
        canvas.width = renderW;
        canvas.height = renderH;
        offscreen.width = renderW;
        offscreen.height = renderH;
        workImageData = null;
      }

      offCtx.clearRect(0, 0, renderW, renderH);
      if (cover) drawImageCover(offCtx, img, renderW, renderH);
      else offCtx.drawImage(img, 0, 0, renderW, renderH);

      const sampled = offCtx.getImageData(0, 0, renderW, renderH);
      basePixels = new Uint8ClampedArray(sampled.data);
      workImageData = sampled;
      needsBaseRebuild = false;
      hasValidFrame = true;
      disabled = false;
      return true;
    }

    function applyStrength(nextStrength) {
      if (disabled || !hasValidFrame) {
        canvas.style.opacity = '0';
        if (img && img.style) img.style.opacity = '1';
        host.classList.remove('is-dithering');
        return;
      }
      canvas.style.opacity = String(Math.min(1, nextStrength * 1.05));
      if (img && img.style) img.style.opacity = '1';
      host.classList.toggle('is-dithering', nextStrength > 0.02);
      if (onStrengthChange) onStrengthChange(nextStrength);
    }

    function render(time, forceDither) {
      if (disabled) return;
      if (!imageReady && !markReady()) return;

      try {
        if (needsBaseRebuild || !basePixels || !workImageData) {
          if (!rebuildBase()) return;
        }

        const targetStrength = getTargetStrength();
        const settled = strength > 0.95 && targetStrength >= 0.95;
        const shouldDither = forceDither || !settled || (frameCount % ditherFrameSkip === 0);

        if (shouldDither) {
          ditherImageDataFast(
            workImageData.data,
            basePixels,
            renderW,
            renderH,
            time,
            mouse.x,
            mouse.y,
            strength
          );
          ctx.putImageData(workImageData, 0, 0);
        }

        applyStrength(strength);
      } catch (err) {
        console.debug('Image dither skipped:', err && err.message ? err.message : err);
        disabled = true;
        hasValidFrame = false;
        needsBaseRebuild = true;
        canvas.style.opacity = '0';
        if (img) img.style.opacity = '1';
      }
    }

    function tick(time) {
      if (paused) {
        rafId = null;
        return;
      }

      frameCount++;
      const targetStrength = getTargetStrength();
      strength += (targetStrength - strength) * 0.12;

      if (imageReady && (strength > 0.01 || targetStrength > 0)) {
        render(time, false);
      }

      if (paused) {
        rafId = null;
        return;
      }

      if (Math.abs(targetStrength - strength) > 0.008 || targetStrength > 0) {
        rafId = requestAnimationFrame(tick);
      } else {
        strength = targetStrength;
        rafId = null;
        if (strength === 0) applyStrength(0);
      }
    }

    function startLoop() {
      if (paused || rafId) return;
      rafId = requestAnimationFrame(tick);
    }

    function pause() {
      paused = true;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    }

    function resume() {
      if (!paused && rafId) return;
      paused = false;
      startLoop();
    }

    function onImageLoad() {
      disabled = false;
      if (markReady()) startLoop();
    }

    function onImageError() {
      imageReady = false;
      basePixels = null;
      hasValidFrame = false;
      disabled = true;
      canvas.style.opacity = '0';
      if (img) img.style.opacity = '1';
    }

    img.addEventListener('load', onImageLoad);
    img.addEventListener('error', onImageError);
    ensureImageReady();

    return {
      startLoop,
      pause,
      resume,
      invalidate() {
        needsBaseRebuild = true;
        hasValidFrame = false;
        disabled = false;
      },
      destroy() {
        pause();
        img.removeEventListener('load', onImageLoad);
        img.removeEventListener('error', onImageError);
        canvas.style.opacity = '0';
        host.classList.remove('is-dithering');
      }
    };
  }

  function cleanupTextDitherArtifacts() {
    const voidAccent = document.querySelector('.title-line.accent');
    if (voidAccent) {
      const legacy = voidAccent.querySelector('.text-dither-source, .text-dither-label');
      if (legacy) {
        const text = legacy.textContent;
        voidAccent.textContent = text || voidAccent.dataset.text || 'Void';
      }
      voidAccent.querySelectorAll('.text-dither-canvas, .link-dither-canvas').forEach((c) => c.remove());
      voidAccent.classList.remove('is-pixel-dithering', 'is-link-dithering');
      delete voidAccent.dataset.textDitherBound;
      delete voidAccent.dataset.linkDitherBound;
    }

    document.querySelectorAll('.link-dither-host').forEach((host) => {
      const link = host.querySelector('a');
      if (link && host.parentNode) {
        host.parentNode.insertBefore(link, host);
        host.remove();
      }
    });
    document.querySelectorAll('a .link-dither-canvas').forEach((canvas) => canvas.remove());
    document.querySelectorAll('a.is-link-dithering').forEach((link) => {
      link.classList.remove('is-link-dithering');
      link.style.backgroundImage = '';
      delete link.dataset.linkDitherBound;
    });
  }

  // Procedural Bayer field - used for overlays that can't read image pixels (CORS, text, UI)
  function fillProceduralDither(ctx, w, h, time, mouseX, mouseY, alphaScale) {
    const imageData = ctx.createImageData(w, h);
    const data = imageData.data;
    const phaseShift = ((time * 0.018) + (mouseX * 14) + (mouseY * 9)) | 0;
    const aScale = alphaScale == null ? 1 : alphaScale;
    const palette = [
      [0, 0, 0, 0],
      [0, 255, 136, Math.round(160 * aScale)],
      [255, 255, 255, Math.round(210 * aScale)]
    ];

    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const x = p % w;
      const y = (p / w) | 0;
      const bayer = BAYER_4X4[((y & 3) * 4) + ((x + phaseShift) & 3)];
      let level = 0;
      if (bayer > 10) level = 2;
      else if (bayer > 4) level = 1;
      const c = palette[level];
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = c[3];
    }
    ctx.putImageData(imageData, 0, 0);
  }

  function bindOverlayDither(host, canvas, opts) {
    if (!ditherEnabled || !host || !canvas) return;
    const options = opts || {};
    const scale = options.scale || 0.35;
    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    let rafId = null;
    let active = false;
    let mouse = { x: 0.5, y: 0.5 };
    let frame = 0;

    function size() {
      const rect = host.getBoundingClientRect();
      const w = Math.max(1, Math.round(Math.max(rect.width, 24) * scale));
      const h = Math.max(1, Math.round(Math.max(rect.height, 24) * scale));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      return { w, h };
    }

    function tick(time) {
      if (!active) {
        rafId = null;
        return;
      }
      if ((frame++ & 1) === 0) {
        const { w, h } = size();
        fillProceduralDither(ctx, w, h, time, mouse.x, mouse.y, options.alpha);
      }
      rafId = requestAnimationFrame(tick);
    }

    function start() {
      active = true;
      host.classList.add('is-dithering');
      if (!rafId) rafId = requestAnimationFrame(tick);
    }

    function stop() {
      active = false;
      host.classList.remove('is-dithering');
    }

    host.addEventListener('mouseenter', start);
    host.addEventListener('mouseleave', stop);

    return { start, stop };
  }

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ditherEnabled = !prefersReducedMotion && window.innerWidth > 768;

  function initPortfolioDither(item) {
    if (!ditherEnabled) return;

    const media = item.querySelector('.portfolio-item-media');
    const img = item.querySelector('img');
    const canvas = item.querySelector('.portfolio-dither-canvas');
    if (!media || !img || !canvas) return;

    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    const offscreen = document.createElement('canvas');
    const offCtx = offscreen.getContext('2d', { willReadFrequently: true, alpha: false });

    let strength = 0;
    let targetStrength = 0;
    // Fixed sample point - no cursor-driven phase warp on hover
    const mouse = { x: 0.5, y: 0.5 };
    let rafId = null;
    let imageReady = false;
    let decoding = false;
    let renderW = 0;
    let renderH = 0;
    let basePixels = null;      // cached downscaled source
    let workImageData = null;   // reusable buffer for putImageData
    let frameCount = 0;
    let needsBaseRebuild = true;
    const renderScale = 0.22;   // lower = cheaper (was 0.45)
    const ditherFrameSkip = 2;  // run dither every Nth frame once settled

    function markReady() {
      if (!img.naturalWidth) return false;
      imageReady = true;
      needsBaseRebuild = true;
      return true;
    }

    function ensureImageReady() {
      if (imageReady || markReady()) return Promise.resolve(true);
      if (decoding) return Promise.resolve(false);

      decoding = true;

      const ready = img.decode
        ? img.decode().then(() => markReady()).catch(() => markReady())
        : new Promise((resolve) => {
            const onLoad = () => {
              cleanup();
              resolve(markReady());
            };
            const onError = () => {
              cleanup();
              resolve(false);
            };
            const cleanup = () => {
              img.removeEventListener('load', onLoad);
              img.removeEventListener('error', onError);
            };
            img.addEventListener('load', onLoad, { once: true });
            img.addEventListener('error', onError, { once: true });
            if (img.complete) onLoad();
          });

      return ready.finally(() => {
        decoding = false;
      });
    }

    img.addEventListener('load', markReady);
    img.addEventListener('error', () => {
      imageReady = false;
      basePixels = null;
    });
    ensureImageReady();

    function rebuildBase() {
      const rect = media.getBoundingClientRect();
      const nextW = Math.max(1, Math.round(rect.width * renderScale));
      const nextH = Math.max(1, Math.round(rect.height * renderScale));

      if (nextW !== renderW || nextH !== renderH || !basePixels) {
        renderW = nextW;
        renderH = nextH;
        canvas.width = renderW;
        canvas.height = renderH;
        offscreen.width = renderW;
        offscreen.height = renderH;
        workImageData = null;
      }

      offCtx.clearRect(0, 0, renderW, renderH);
      offCtx.drawImage(img, 0, 0, renderW, renderH);
      const sampled = offCtx.getImageData(0, 0, renderW, renderH);
      basePixels = new Uint8ClampedArray(sampled.data);
      workImageData = sampled; // reuse this ImageData object
      needsBaseRebuild = false;
    }

    function render(time, forceDither) {
      if (!imageReady && !markReady()) return;

      try {
        if (needsBaseRebuild || !basePixels || !workImageData) {
          rebuildBase();
        }

        const settled = strength > 0.95 && targetStrength === 1;
        const shouldDither = forceDither || !settled || (frameCount % ditherFrameSkip === 0);

        if (shouldDither) {
          ditherImageDataFast(
            workImageData.data,
            basePixels,
            renderW,
            renderH,
            time,
            mouse.x,
            mouse.y,
            strength
          );
          ctx.putImageData(workImageData, 0, 0);
        }

        canvas.style.opacity = String(Math.min(1, strength * 1.05));
        img.style.opacity = '1';
        item.classList.toggle('is-dithering', strength > 0.02);
      } catch (err) {
        console.debug('Dither render skipped:', err && err.message ? err.message : err);
        needsBaseRebuild = true;
      }
    }

    function tick(time) {
      frameCount++;
      strength += (targetStrength - strength) * 0.48;

      if (imageReady && (strength > 0.01 || targetStrength > 0)) {
        render(time, false);
      }

      if (Math.abs(targetStrength - strength) > 0.008 || targetStrength > 0) {
        rafId = requestAnimationFrame(tick);
      } else {
        strength = targetStrength;
        rafId = null;
        if (strength === 0) {
          canvas.style.opacity = '0';
          img.style.opacity = '1';
          item.classList.remove('is-dithering');
        }
      }
    }

    function startLoop() {
      if (!rafId) rafId = requestAnimationFrame(tick);
    }

    function clearHover() {
      // Scroll-in reveal owns the fade; don't interrupt it
      if (item.dataset.ditherReveal === '1') return;
      targetStrength = 0;
      startLoop();
    }

    function setHover() {
      // Only one hover dither at a time (scroll/stutter can otherwise leave several active)
      if (activePortfolioDitherHover && activePortfolioDitherHover !== item) {
        const prev = portfolioDitherHoverApi.get(activePortfolioDitherHover);
        if (prev) prev.clearHover();
      }
      activePortfolioDitherHover = item;
      targetStrength = 1;
      needsBaseRebuild = true;
      ensureImageReady().then((ready) => {
        if (ready || imageReady) startLoop();
      });
      startLoop();
    }

    portfolioDitherHoverApi.set(item, { setHover, clearHover });

    item.addEventListener('mouseenter', setHover);

    item.addEventListener('mouseleave', () => {
      if (activePortfolioDitherHover === item) activePortfolioDitherHover = null;
      clearHover();
    });

    window.addEventListener('resize', () => {
      needsBaseRebuild = true;
      if (strength > 0) startLoop();
    });

    // Scroll-in reveal: start fully dithered, dissolve to clean image
    item._ditherReveal = function ditherReveal() {
      if (item.dataset.ditherRevealed === '1') return;
      item.dataset.ditherRevealed = '1';
      item.dataset.ditherReveal = '1';
      // Reveal is not a hover lock - drop hover claim so other items can activate
      if (activePortfolioDitherHover === item) activePortfolioDitherHover = null;
      ensureImageReady().then(() => {
        strength = 1;
        targetStrength = 0;
        needsBaseRebuild = true;
        startLoop();
        setTimeout(() => {
          item.dataset.ditherReveal = '0';
        }, 900);
      });
    };
  }

  // Single active hover dither + pointer sync (mouseleave often skips on scroll)
  let activePortfolioDitherHover = null;
  const portfolioDitherHoverApi = new WeakMap();
  const ditherPointer = { x: 0, y: 0, has: false };
  let ditherHoverSyncQueued = false;

  function syncPortfolioDitherHover() {
    ditherHoverSyncQueued = false;
    if (!ditherEnabled || !ditherPointer.has || !activePortfolioDitherHover) return;

    const under = document.elementFromPoint(ditherPointer.x, ditherPointer.y);
    const item = under && under.closest ? under.closest('.portfolio-item') : null;

    if (activePortfolioDitherHover !== item) {
      const prev = portfolioDitherHoverApi.get(activePortfolioDitherHover);
      if (prev) prev.clearHover();
      activePortfolioDitherHover = null;
    }
  }

  function queuePortfolioDitherHoverSync() {
    if (ditherHoverSyncQueued || !ditherEnabled || !activePortfolioDitherHover) return;
    ditherHoverSyncQueued = true;
    requestAnimationFrame(syncPortfolioDitherHover);
  }

  document.addEventListener('pointermove', (e) => {
    ditherPointer.x = e.clientX;
    ditherPointer.y = e.clientY;
    ditherPointer.has = true;
  }, { passive: true });

  window.addEventListener('scroll', queuePortfolioDitherHoverSync, { passive: true, capture: true });

  // Initialize portfolio on page load
  generatePortfolio();

  // ============================================
  // LOADING SCREEN & SCROLL PREVENTION
  // ============================================
  
  const loadingScreen = document.querySelector('.loading-screen');
  
  // Prevent scroll jump on page load
  window.scrollTo(0, 0);
  document.documentElement.style.scrollBehavior = 'auto';
  
  // Hide loading screen after content loads
  // Note: There's also a 1-second hard timeout in the HTML <head> as a safety net
  function hideLoadingScreen() {
    if (loadingScreen.classList.contains('loaded')) return;
    
    loadingScreen.classList.add('loaded');
    document.documentElement.style.scrollBehavior = 'smooth';
    
    // Remove loading screen from DOM after transition
    setTimeout(() => {
      loadingScreen.style.display = 'none';
    }, 500);
  }
  
  // Hide after minimum time (400ms for smooth UX)
  setTimeout(hideLoadingScreen, 400);

  // ============================================
  // LOCAL TIME DISPLAY
  // ============================================
  
  const timeDisplay = document.getElementById('houston-time');
  
  function updateHoustonTime() {
    const now = new Date();
    const houstonTime = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).format(now);
    
    if (timeDisplay) {
      timeDisplay.textContent = houstonTime;
    }
  }
  
  // Update time immediately and every minute
  updateHoustonTime();
  setInterval(updateHoustonTime, 60000);

  // ============================================
  // SMOOTH SCROLLING
  // ============================================

  // Smooth scroll for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      const href = this.getAttribute('href');
      if (href === '#') return;
      
      e.preventDefault();
      const target = document.querySelector(href);
      if (target) {
        const headerOffset = 100;
        const elementPosition = target.getBoundingClientRect().top;
        const offsetPosition = elementPosition + window.pageYOffset - headerOffset;

        window.scrollTo({
          top: offsetPosition,
          behavior: 'smooth'
        });
      }
    });
  });

  // Parallax for hero statement - strong vertical drift on scroll
  const heroStatement = document.querySelector('.hero-statement');
  if (heroStatement) {
    let ticking = false;
    const PARALLAX_FACTOR = 1.15;
    
    window.addEventListener('scroll', () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          if (window.innerWidth > 768) {
            const rate = window.pageYOffset * PARALLAX_FACTOR;
            heroStatement.style.transform = `translate3d(0, ${rate}px, 0)`;
          } else {
            heroStatement.style.transform = 'none';
          }
          
          ticking = false;
        });
        ticking = true;
      }
    }, { passive: true });
  }

  // Reveal animations on scroll
  const observerOptions = {
    threshold: 0.15,
    rootMargin: '0px 0px -100px 0px'
  };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
      }
    });
  }, observerOptions);

  // Observe elements for reveal (initial load)
  document.querySelectorAll('.hire-card').forEach(el => {
    el.classList.add('fade-in');
    observer.observe(el);
  });

  // Initialize focus product gallery
  function initFocusProducts() {
    document.querySelectorAll('.focus-product-grid .portfolio-item').forEach(initPortfolioDither);
  }

  initFocusProducts();

  // Observe portfolio items after generation
  setTimeout(() => {
    document.querySelectorAll('#portfolio-grid .portfolio-item, .focus-product-grid .portfolio-item').forEach(el => {
      observer.observe(el);
    });
  }, 0);

  // Lightbox for portfolio & focus product galleries
  document.addEventListener('click', (e) => {
    const galleryItem = e.target.closest('.portfolio-item');
    const galleryRoot = galleryItem && galleryItem.closest('#portfolio-grid, .focus-product-grid');
    if (!galleryItem || !galleryRoot) return;

    e.preventDefault();
    const items = Array.from(galleryRoot.querySelectorAll('.portfolio-item'));
    const gallery = items.map((item) => {
      const img = item.querySelector('img');
      return img ? { src: img.currentSrc || img.src, alt: img.alt || '' } : null;
    }).filter(Boolean);
    const startIndex = Math.max(0, items.indexOf(galleryItem));
    if (gallery.length) {
      const label = galleryRoot.classList.contains('focus-product-grid')
        ? 'Dither Boy product gallery'
        : 'Selected works gallery';
      createLightbox(gallery, startIndex, label);
    }
  });

  function createLightbox(gallery, startIndex, ariaLabel) {
    let currentIndex = startIndex;
    const lightbox = document.createElement('div');
    lightbox.className = 'lightbox';
    lightbox.setAttribute('role', 'dialog');
    lightbox.setAttribute('aria-modal', 'true');
    lightbox.setAttribute('aria-label', ariaLabel || 'Selected works gallery');
    lightbox.innerHTML = `
      <canvas class="lightbox-dither-bg" aria-hidden="true"></canvas>
      <div class="lightbox-backdrop"></div>
      <div class="lightbox-content">
        <img src="${gallery[currentIndex].src}" alt="${gallery[currentIndex].alt}" crossorigin="anonymous" draggable="false">
      </div>
    `;
    
    document.body.appendChild(lightbox);
    document.body.style.overflow = 'hidden';

    const ditherCanvas = lightbox.querySelector('.lightbox-dither-bg');
    const backdrop = lightbox.querySelector('.lightbox-backdrop');
    const heroImg = lightbox.querySelector('.lightbox-content img');
    let ditherRaf = null;
    let ditherMouse = { x: 0.5, y: 0.5 };
    let ditherAlive = true;
    let touchStartX = 0;
    let touchStartY = 0;

    const preferMotion = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function startLightboxDither() {
      if (!preferMotion || !ditherCanvas) {
        backdrop.style.background = 'rgba(0, 0, 0, 0.95)';
        if (ditherCanvas) ditherCanvas.style.display = 'none';
        return;
      }

      const ctx = ditherCanvas.getContext('2d', { alpha: false, desynchronized: true });
      const offscreen = document.createElement('canvas');
      const offCtx = offscreen.getContext('2d', { willReadFrequently: true, alpha: false });
      const renderScale = 0.18;
      let basePixels = null;
      let workImageData = null;
      let cachedW = 0;
      let cachedH = 0;
      let frame = 0;
      let needsRebuild = true;

      function invalidateBase() {
        needsRebuild = true;
      }

      function sizeCanvases() {
        const w = Math.max(1, Math.round(window.innerWidth * renderScale));
        const h = Math.max(1, Math.round(window.innerHeight * renderScale));
        if (ditherCanvas.width !== w || ditherCanvas.height !== h) {
          ditherCanvas.width = w;
          ditherCanvas.height = h;
          offscreen.width = w;
          offscreen.height = h;
          needsRebuild = true;
        }
        return { w, h };
      }

      function rebuildBase(w, h) {
        offCtx.clearRect(0, 0, w, h);
        drawImageCover(offCtx, heroImg, w, h);
        workImageData = offCtx.getImageData(0, 0, w, h);
        basePixels = new Uint8ClampedArray(workImageData.data);
        cachedW = w;
        cachedH = h;
        needsRebuild = false;
      }

      function renderFrame(time) {
        if (!ditherAlive) return;
        if (!heroImg.naturalWidth) {
          ditherRaf = requestAnimationFrame(renderFrame);
          return;
        }

        try {
          const { w, h } = sizeCanvases();
          if (needsRebuild || !basePixels || !workImageData || w !== cachedW || h !== cachedH) {
            rebuildBase(w, h);
          }

          // Animate dither every other frame - still looks smooth when upscaled
          if ((frame++ & 1) === 0) {
            ditherImageDataFast(
              workImageData.data,
              basePixels,
              w,
              h,
              time,
              ditherMouse.x,
              ditherMouse.y,
              1
            );
            ctx.putImageData(workImageData, 0, 0);
          }
        } catch (err) {
          console.debug('Lightbox dither skipped:', err && err.message ? err.message : err);
          needsRebuild = true;
        }

        ditherRaf = requestAnimationFrame(renderFrame);
      }

      lightbox.addEventListener('mousemove', (e) => {
        ditherMouse.x = e.clientX / Math.max(1, window.innerWidth);
        ditherMouse.y = e.clientY / Math.max(1, window.innerHeight);
      });

      window.addEventListener('resize', () => {
        needsRebuild = true;
      });

      heroImg.addEventListener('load', invalidateBase);
      lightbox._invalidateDitherBase = invalidateBase;

      if (heroImg.complete && heroImg.naturalWidth) {
        ditherRaf = requestAnimationFrame(renderFrame);
      } else {
        heroImg.addEventListener('load', () => {
          ditherRaf = requestAnimationFrame(renderFrame);
        }, { once: true });
      }
    }

    startLightboxDither();

    function showImage(index, direction) {
      if (!gallery.length) return;
      currentIndex = (index + gallery.length) % gallery.length;
      const next = gallery[currentIndex];

      heroImg.style.transition = 'opacity 0.18s ease, transform 0.18s ease';
      heroImg.style.opacity = '0';
      heroImg.style.transform = direction > 0
        ? 'translateX(24px)'
        : direction < 0
          ? 'translateX(-24px)'
          : 'scale(0.98)';

      const swap = () => {
        heroImg.src = next.src;
        heroImg.alt = next.alt;
        if (lightbox._invalidateDitherBase) lightbox._invalidateDitherBase();
        const reveal = () => {
          heroImg.style.transform = direction > 0
            ? 'translateX(-24px)'
            : direction < 0
              ? 'translateX(24px)'
              : 'scale(0.98)';
          requestAnimationFrame(() => {
            heroImg.style.opacity = '1';
            heroImg.style.transform = 'translateX(0) scale(1)';
          });
        };
        if (heroImg.complete && heroImg.naturalWidth) reveal();
        else heroImg.addEventListener('load', reveal, { once: true });
      };

      setTimeout(swap, 140);
    }

    function goNext() { showImage(currentIndex + 1, 1); }
    function goPrev() { showImage(currentIndex - 1, -1); }
    
    // Always refresh lightbox styles for this revision
    const oldStyles = document.getElementById('lightbox-styles');
    if (oldStyles) oldStyles.remove();
    const existingV2 = document.getElementById('lightbox-styles-v2');
    if (!existingV2) {
      const style = document.createElement('style');
      style.id = 'lightbox-styles-v2';
      style.textContent = `
        .lightbox {
          position: fixed;
          inset: 0;
          z-index: 9999;
          display: flex;
          align-items: center;
          justify-content: center;
          animation: fadeIn 0.3s ease;
          touch-action: pan-y;
        }
        
        .lightbox-dither-bg {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          z-index: 0;
          pointer-events: none;
          image-rendering: pixelated;
          image-rendering: crisp-edges;
          opacity: 0;
          animation: lightboxDitherIn 0.45s ease forwards;
        }

        @keyframes lightboxDitherIn {
          from { opacity: 0; transform: scale(1.08); }
          to { opacity: 1; transform: scale(1); }
        }
        
        .lightbox-backdrop {
          position: absolute;
          inset: 0;
          z-index: 1;
          background: rgba(0, 0, 0, 0.45);
          cursor: pointer;
        }
        
        .lightbox-content {
          position: relative;
          z-index: 2;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          height: 100%;
          padding: 0;
          margin: 0;
          pointer-events: none;
          animation: lightboxImageIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        }

        @keyframes lightboxImageIn {
          from {
            opacity: 0;
            transform: scale(0.94);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }
        
        .lightbox-content img {
          max-width: min(90vw, 1200px);
          max-height: 90vh;
          width: auto;
          height: auto;
          object-fit: contain;
          border: 2px solid white;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55);
          display: block;
          margin: 0 auto;
          pointer-events: auto;
          user-select: none;
          -webkit-user-drag: none;
        }
        
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        
        .fade-in {
          opacity: 0;
          transform: translateY(30px);
          transition: opacity 0.6s ease, transform 0.6s ease;
        }
        
        .fade-in.is-visible {
          opacity: 1;
          transform: translateY(0);
        }

        @media (prefers-reduced-motion: reduce) {
          .lightbox-dither-bg {
            display: none;
          }
          .lightbox-backdrop {
            background: rgba(0, 0, 0, 0.95);
          }
          .lightbox-content {
            animation: none;
          }
        }
      `;
      document.head.appendChild(style);
    }
    
    // Close handlers
    const close = () => {
      ditherAlive = false;
      if (ditherRaf) cancelAnimationFrame(ditherRaf);
      document.removeEventListener('keydown', handleKey);
      lightbox.style.opacity = '0';
      lightbox.style.transition = 'opacity 0.3s ease';
      setTimeout(() => {
        if (lightbox.parentNode) {
          document.body.removeChild(lightbox);
        }
        document.body.style.overflow = '';
      }, 300);
    };
    
    lightbox.querySelector('.lightbox-backdrop').addEventListener('click', close);

    const handleKey = (e) => {
      if (e.key === 'Escape') {
        close();
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        goNext();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        goPrev();
      }
    };
    document.addEventListener('keydown', handleKey);

    // Swipe navigation
    lightbox.addEventListener('touchstart', (e) => {
      if (!e.touches[0]) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    lightbox.addEventListener('touchend', (e) => {
      const touch = e.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - touchStartX;
      const dy = touch.clientY - touchStartY;
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
      if (dx < 0) goNext();
      else goPrev();
    }, { passive: true });
  }

  // Cursor following effect - soft dithered action cursor (no hard border)
  // Keep JS + cursor:none CSS in sync via matchMedia so a resize can't show both.
  {
    const cursorMq = window.matchMedia('(min-width: 769px)');
    const useDitherCursor = !prefersReducedMotion;
    let cursorEnabled = cursorMq.matches;

    const cursor = document.createElement('div');
    cursor.className = 'custom-cursor';
    if (useDitherCursor) {
      cursor.innerHTML = '<canvas class="custom-cursor-dither" width="12" height="12" aria-hidden="true"></canvas><span>VIEW</span>';
    } else {
      cursor.textContent = 'VIEW';
    }
    document.body.appendChild(cursor);

    const cursorLabel = useDitherCursor ? cursor.querySelector('span') : cursor;
    const cursorCanvas = useDitherCursor ? cursor.querySelector('canvas') : null;
    const cursorCtx = cursorCanvas ? cursorCanvas.getContext('2d', { alpha: true }) : null;
    let cursorFrame = 0;
    let cursorRaf = null;
    let cursorActive = false;

    function getCursorTarget(el) {
      if (!el || !el.closest) return null;
      return el.closest('[data-cursor], .portfolio-item');
    }

    function getCursorLabel(target) {
      if (!target) return 'VIEW';
      const label = target.getAttribute('data-cursor');
      return label && label.trim() ? label.trim().toUpperCase() : 'VIEW';
    }

    function setCursorLabel(label) {
      if (cursorLabel.textContent !== label) cursorLabel.textContent = label;
    }

    function deactivateCursor() {
      cursor.classList.remove('active');
      cursorActive = false;
    }

    function syncCursorMode() {
      cursorEnabled = cursorMq.matches;
      document.documentElement.classList.toggle('has-action-cursor', cursorEnabled);
      if (!cursorEnabled) deactivateCursor();
    }

    function paintCursor(time) {
      if (!cursorActive || !cursorEnabled || !cursorCtx) {
        cursorRaf = null;
        return;
      }
      if ((cursorFrame++ & 1) === 0) {
        const renderSize = 12;
        if (cursorCanvas.width !== renderSize) cursorCanvas.width = renderSize;
        if (cursorCanvas.height !== renderSize) cursorCanvas.height = renderSize;

        const offscreen = document.createElement('canvas');
        offscreen.width = renderSize;
        offscreen.height = renderSize;
        const offCtx = offscreen.getContext('2d', { willReadFrequently: true, alpha: true });
        const cx = (renderSize - 1) * 0.5;
        const cy = (renderSize - 1) * 0.5;
        const radius = renderSize * 0.46;

        offCtx.clearRect(0, 0, renderSize, renderSize);
        const grad = offCtx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.35, '#00ff88');
        grad.addColorStop(0.72, '#00cc6a');
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        offCtx.beginPath();
        offCtx.arc(cx, cy, radius, 0, Math.PI * 2);
        offCtx.fillStyle = grad;
        offCtx.fill();

        const imageData = offCtx.getImageData(0, 0, renderSize, renderSize);
        const data = imageData.data;
        const radiusSq = radius * radius;
        for (let i = 0, p = 0; i < data.length; i += 4, p++) {
          const x = p % renderSize;
          const y = (p / renderSize) | 0;
          const dx = x - cx;
          const dy = y - cy;
          if ((dx * dx + dy * dy) > radiusSq || data[i + 3] < 8) {
            data[i] = 0;
            data[i + 1] = 0;
            data[i + 2] = 0;
            data[i + 3] = 0;
          }
        }

        const src = new Uint8ClampedArray(data);
        ditherImageDataFast(
          imageData.data,
          src,
          renderSize,
          renderSize,
          time,
          0.5,
          0.5,
          1
        );

        // Re-apply transparency after dither (dither only touches RGB)
        for (let i = 0, p = 0; i < data.length; i += 4, p++) {
          const x = p % renderSize;
          const y = (p / renderSize) | 0;
          const dx = x - cx;
          const dy = y - cy;
          if ((dx * dx + dy * dy) > radiusSq) data[i + 3] = 0;
        }

        cursorCtx.clearRect(0, 0, renderSize, renderSize);
        cursorCtx.putImageData(imageData, 0, 0);
      }
      cursorRaf = requestAnimationFrame(paintCursor);
    }

    if (document.getElementById('cursor-styles')) {
      document.getElementById('cursor-styles').remove();
    }
    const style = document.createElement('style');
    style.id = 'cursor-styles';
    style.textContent = useDitherCursor ? `
        .custom-cursor {
          position: fixed;
          width: 72px;
          height: 72px;
          display: flex;
          align-items: center;
          justify-content: center;
          pointer-events: none;
          z-index: 9998;
          opacity: 0;
          transform: translate(-50%, -50%) scale(0.5);
          transition: opacity 0.2s ease, transform 0.2s ease;
          border: none;
          background: transparent;
          border-radius: 0;
          box-shadow: none;
        }

        .custom-cursor-dither {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          background: transparent;
          image-rendering: pixelated;
          image-rendering: crisp-edges;
        }

        .custom-cursor span {
          position: relative;
          z-index: 1;
          font-family: 'Space Mono', monospace;
          font-size: 0.6875rem;
          font-weight: 700;
          letter-spacing: 0.08em;
          color: #000;
          text-shadow:
            0 0 2px #00ff88,
            0 1px 0 #00ff88,
            0 -1px 0 #00ff88,
            1px 0 0 #00ff88,
            -1px 0 0 #00ff88;
        }
        
        .custom-cursor.active {
          opacity: 1;
          transform: translate(-50%, -50%) scale(1);
        }
      ` : `
        .custom-cursor {
          position: fixed;
          width: 60px;
          height: 60px;
          border-radius: 50%;
          background: #00ff88;
          color: black;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: 'Space Mono', monospace;
          font-size: 0.625rem;
          font-weight: 700;
          pointer-events: none;
          z-index: 9998;
          opacity: 0;
          transform: translate(-50%, -50%) scale(0.5);
          transition: opacity 0.2s ease, transform 0.2s ease;
        }
        .custom-cursor.active {
          opacity: 1;
          transform: translate(-50%, -50%) scale(1);
        }
      `;
    document.head.appendChild(style);

    syncCursorMode();
    if (typeof cursorMq.addEventListener === 'function') {
      cursorMq.addEventListener('change', syncCursorMode);
    } else if (typeof cursorMq.addListener === 'function') {
      cursorMq.addListener(syncCursorMode);
    }

    document.addEventListener('mouseenter', (e) => {
      if (!cursorEnabled) return;
      const target = getCursorTarget(e.target);
      if (target) {
        setCursorLabel(getCursorLabel(target));
        cursor.classList.add('active');
        cursorActive = true;
        if (useDitherCursor && !cursorRaf) cursorRaf = requestAnimationFrame(paintCursor);
      }
    }, true);

    document.addEventListener('mouseleave', (e) => {
      if (!cursorEnabled) return;
      if (getCursorTarget(e.target)) deactivateCursor();
    }, true);

    document.addEventListener('mousemove', (e) => {
      if (!cursorEnabled) {
        if (cursorActive) deactivateCursor();
        return;
      }
      const target = getCursorTarget(e.target);
      if (target) {
        setCursorLabel(getCursorLabel(target));
        cursor.style.left = e.clientX + 'px';
        cursor.style.top = e.clientY + 'px';
        if (!cursor.classList.contains('active')) {
          cursor.classList.add('active');
          cursorActive = true;
          if (useDitherCursor && !cursorRaf) cursorRaf = requestAnimationFrame(paintCursor);
        }
      } else if (cursorActive) {
        deactivateCursor();
      }
    });
  }

  // ============================================
  // LIVE DITHER EFFECTS (site-wide)
  // ============================================

  // Pure-black panel with Bayer-masked edges (pixelated boundary, no interior color)
  function fillPanelDither(ctx, w, h, time, mouseX, mouseY) {
    const imageData = ctx.createImageData(w, h);
    const data = imageData.data;
    const phaseShift = ((time * 0.012) + (mouseX * 12) + (mouseY * 7)) | 0;
    const edgePx = 6;
    const alphas = new Uint8Array(w * h);

    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const x = p % w;
      const y = (p / w) | 0;
      const distEdge = Math.min(x, y, w - 1 - x, h - 1 - y);

      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;

      let a = 0;
      if (distEdge >= edgePx) {
        a = 255;
      } else {
        const t = distEdge / edgePx;
        const bayer = BAYER_4X4[((y & 3) * 4) + ((x + phaseShift) & 3)];
        const threshold = (1 - t) * 15;
        a = bayer >= threshold ? 255 : 0;
      }

      alphas[p] = a;
      data[i + 3] = a;
    }

    const src = new Uint8ClampedArray(data);
    ditherImageDataFast(data, src, w, h, time, mouseX, mouseY, 1);

    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      data[i + 3] = alphas[p];
    }

    ctx.putImageData(imageData, 0, 0);
  }

  function initLoadingDither() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const loadingCanvas = document.querySelector('.loading-dither');
    const loadingScreenEl = document.querySelector('.loading-screen');
    const loadingContent = document.querySelector('.loading-content');
    const panelCanvas = loadingContent && loadingContent.querySelector('.loading-panel-dither');

    // Background wash - keep existing procedural dither
    if (loadingCanvas && loadingScreenEl) {
      const ctx = loadingCanvas.getContext('2d', { alpha: true, desynchronized: true });
      let loadingAlive = true;

      function sizeLoading() {
        const w = Math.max(1, Math.round(window.innerWidth * 0.12));
        const h = Math.max(1, Math.round(window.innerHeight * 0.12));
        if (loadingCanvas.width !== w) loadingCanvas.width = w;
        if (loadingCanvas.height !== h) loadingCanvas.height = h;
        return { w, h };
      }

      function tickLoading(time) {
        if (!loadingAlive || loadingScreenEl.classList.contains('loaded')) {
          loadingAlive = false;
          return;
        }
        const { w, h } = sizeLoading();
        fillProceduralDither(ctx, w, h, time, 0.4, 0.5, 1);
        requestAnimationFrame(tickLoading);
      }
      requestAnimationFrame(tickLoading);
    }

    // Black content panel - blocks the wash, lightly dithered like VIEW cursor
    if (!loadingContent || !panelCanvas || !loadingScreenEl) return;

    const ctx = panelCanvas.getContext('2d', { alpha: true, desynchronized: true });
    const renderScale = 0.22;
    let panelAlive = true;
    let panelFrame = 0;
    let needsResize = true;

    function sizePanel() {
      const rect = loadingContent.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * renderScale));
      const h = Math.max(1, Math.round(rect.height * renderScale));
      if (panelCanvas.width !== w) panelCanvas.width = w;
      if (panelCanvas.height !== h) panelCanvas.height = h;
      return { w, h };
    }

    function tickPanel(time) {
      if (!panelAlive || loadingScreenEl.classList.contains('loaded')) {
        panelAlive = false;
        return;
      }

      if (needsResize || (panelFrame++ & 1) === 0) {
        const { w, h } = sizePanel();
        fillPanelDither(ctx, w, h, time, 0.5, 0.5);
        needsResize = false;
      }

      requestAnimationFrame(tickPanel);
    }

    requestAnimationFrame(tickPanel);
    window.addEventListener('resize', () => { needsResize = true; });
  }

  function initLiveDitherEffects() {
    // 1) Focus / Dither Boy wash - desktop only
    if (ditherEnabled) {
      const focusSection = document.querySelector('.focus-section');
      const focusWash = document.querySelector('.focus-dither-wash');
      if (focusSection && focusWash) {
        const ctx = focusWash.getContext('2d', { alpha: true, desynchronized: true });
        let focusRaf = null;
        let focusInView = false;
        let focusFrame = 0;
        let focusMouse = { x: 0.5, y: 0.5 };
        let focusSize = { w: 0, h: 0 };
        let focusNeedsResize = true;

        function sizeFocus(force) {
          if (!force && !focusNeedsResize && focusSize.w) return focusSize;
          const rect = focusSection.getBoundingClientRect();
          const w = Math.max(1, Math.round(rect.width * 0.14));
          const h = Math.max(1, Math.round(rect.height * 0.14));
          if (focusWash.width !== w) focusWash.width = w;
          if (focusWash.height !== h) focusWash.height = h;
          focusSize = { w, h };
          focusNeedsResize = false;
          return focusSize;
        }

        function focusShouldRun() {
          return focusInView && !document.hidden;
        }

        function tickFocus(time) {
          if (!focusShouldRun()) {
            focusRaf = null;
            return;
          }
          if ((focusFrame++ & 2) === 0) {
            const { w, h } = sizeFocus(false);
            fillProceduralDither(ctx, w, h, time, focusMouse.x, focusMouse.y, 0.7);
          }
          focusRaf = requestAnimationFrame(tickFocus);
        }

        function ensureFocusLoop() {
          if (focusShouldRun() && !focusRaf) focusRaf = requestAnimationFrame(tickFocus);
        }

        focusSection.addEventListener('mousemove', (e) => {
          const rect = focusSection.getBoundingClientRect();
          focusMouse.x = (e.clientX - rect.left) / Math.max(1, rect.width);
          focusMouse.y = (e.clientY - rect.top) / Math.max(1, rect.height);
        }, { passive: true });

        window.addEventListener('resize', () => {
          focusNeedsResize = true;
        }, { passive: true });

        document.addEventListener('visibilitychange', () => {
          if (document.hidden) {
            if (focusRaf) {
              cancelAnimationFrame(focusRaf);
              focusRaf = null;
            }
          } else {
            ensureFocusLoop();
          }
        });

        new IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            focusInView = entry.isIntersecting;
            if (focusInView) {
              focusNeedsResize = true;
              ensureFocusLoop();
            } else if (focusRaf) {
              cancelAnimationFrame(focusRaf);
              focusRaf = null;
            }
          });
        }, { threshold: 0.15 }).observe(focusSection);
      }
    }

    // 2) Now-playing artwork - dither while visible; freeze last frame when offscreen/hidden
    if (!prefersReducedMotion) {
      let nowPlayingDitherController = null;
      let nowPlayingCorsObjectUrl = null;
      let nowPlayingInView = true;
      let nowPlayingArtEl = null;
      let nowPlayingIo = null;

      function revokeNowPlayingCorsUrl() {
        if (nowPlayingCorsObjectUrl) {
          URL.revokeObjectURL(nowPlayingCorsObjectUrl);
          nowPlayingCorsObjectUrl = null;
        }
      }

      function syncNowPlayingDitherPlayback() {
        if (!nowPlayingDitherController) return;
        if (nowPlayingInView && !document.hidden) nowPlayingDitherController.resume();
        else nowPlayingDitherController.pause();
      }

      function observeNowPlayingArt(art) {
        if (nowPlayingArtEl === art && nowPlayingIo) return;
        if (nowPlayingIo) {
          nowPlayingIo.disconnect();
          nowPlayingIo = null;
        }
        nowPlayingArtEl = art;
        if (!art) return;
        nowPlayingIo = new IntersectionObserver((entries) => {
          nowPlayingInView = entries.some((entry) => entry.isIntersecting);
          syncNowPlayingDitherPlayback();
        }, { threshold: 0.01, rootMargin: '80px 0px' });
        nowPlayingIo.observe(art);
      }

      async function loadCorsImageSource(url) {
        if (!url) return null;

        async function blobFromFetch(fetchUrl) {
          const res = await fetch(fetchUrl, { mode: 'cors', credentials: 'omit' });
          if (!res.ok) throw new Error('fetch failed');
          return await res.blob();
        }

        try {
          return URL.createObjectURL(await blobFromFetch(url));
        } catch (e) {
          try {
            const proxy =
              'https://wsrv.nl/?url=' +
              encodeURIComponent(url) +
              '&w=300&h=300&fit=cover&output=jpg';
            return URL.createObjectURL(await blobFromFetch(proxy));
          } catch (err) {
            return null;
          }
        }
      }

      async function bindNowPlayingDither() {
        if (nowPlayingDitherController) {
          nowPlayingDitherController.destroy();
          nowPlayingDitherController = null;
        }
        revokeNowPlayingCorsUrl();

        const art = document.querySelector('.now-playing-artwork');
        const canvas = art && art.querySelector('.dither-overlay-canvas');
        const img =
          art &&
          (art.querySelector('img.now-playing-art-front') || art.querySelector('img'));
        if (!art || !canvas || !img || !img.getAttribute('src')) {
          if (canvas) canvas.style.opacity = '0';
          if (art) art.classList.remove('is-dithering');
          return;
        }

        // Dither only while Now Playing - Last Played shows clean cover art
        const card = art.closest('.now-playing-card');
        if (!card || !card.classList.contains('playing')) {
          canvas.style.opacity = '0';
          art.classList.remove('is-dithering');
          return;
        }

        img.removeAttribute('crossorigin');
        // Layer opacity is controlled by .is-visible; don't force inline opacity
        img.style.removeProperty('opacity');
        art.classList.remove('is-missing');
        art.style.display = '';

        const waitForDisplayImage = () => {
          if (img.complete && img.naturalWidth > 0) return Promise.resolve(true);
          return new Promise((resolve) => {
            const finish = (ok) => {
              img.removeEventListener('load', onLoad);
              img.removeEventListener('error', onError);
              resolve(ok);
            };
            const onLoad = () => finish(img.naturalWidth > 0);
            const onError = () => finish(false);
            img.addEventListener('load', onLoad, { once: true });
            img.addEventListener('error', onError, { once: true });
          });
        };

        const displayOk = await waitForDisplayImage();
        if (!displayOk || !img.isConnected) {
          canvas.style.opacity = '0';
          return;
        }

        const corsUrl = await loadCorsImageSource(img.currentSrc || img.src);
        if (!corsUrl || !img.isConnected) {
          canvas.style.opacity = '0';
          return;
        }

        nowPlayingCorsObjectUrl = corsUrl;
        const ditherImg = new Image();
        ditherImg.decoding = 'async';
        ditherImg.src = corsUrl;

        await new Promise((resolve) => {
          if (ditherImg.complete && ditherImg.naturalWidth > 0) {
            resolve();
            return;
          }
          ditherImg.onload = () => resolve();
          ditherImg.onerror = () => resolve();
        });

        if (!ditherImg.naturalWidth || !img.isConnected) {
          canvas.style.opacity = '0';
          revokeNowPlayingCorsUrl();
          return;
        }

        const controller = createImageDitherController({
          host: art,
          img: ditherImg,
          canvas,
          renderScale: window.innerWidth <= 768 ? 0.18 : 0.22,
          cover: true,
          getTargetStrength: () => 1
        });

        img.style.opacity = '1';

        nowPlayingDitherController = {
          pause() { controller.pause(); },
          resume() { controller.resume(); },
          invalidate() { controller.invalidate(); },
          startLoop() { controller.startLoop(); },
          destroy() {
            controller.destroy();
            revokeNowPlayingCorsUrl();
          }
        };

        observeNowPlayingArt(art);
        controller.startLoop();
        // Freeze immediately if tab is backgrounded; IO handles offscreen after first paint
        if (document.hidden) controller.pause();
      }

      document.addEventListener('visibilitychange', syncNowPlayingDitherPlayback);
      document.addEventListener('now-playing:updated', () => { bindNowPlayingDither(); });
      document.addEventListener('now-playing:art-updated', () => { bindNowPlayingDither(); });
      bindNowPlayingDither();
    }

    // 3) Portfolio scroll-in dither reveal - desktop only
    if (!ditherEnabled) return;

    setTimeout(() => {
      const revealObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && entry.target._ditherReveal) {
            entry.target._ditherReveal();
            revealObserver.unobserve(entry.target);
          }
        });
      }, { threshold: 0.35, rootMargin: '0px 0px -8% 0px' });

      document.querySelectorAll('.portfolio-item').forEach((item) => {
        revealObserver.observe(item);
      });
    }, 50);
  }

  initLoadingDither();
  cleanupTextDitherArtifacts();
  initLiveDitherEffects();

  // Animate section numbers on scroll
  const sectionNumbers = document.querySelectorAll('.section-number');
  const numberObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.animation = 'slideInRight 0.6s ease forwards';
      }
    });
  }, { threshold: 0.5 });

  if (!document.getElementById('number-animation')) {
    const style = document.createElement('style');
    style.id = 'number-animation';
    style.textContent = `
      @keyframes slideInRight {
        from {
          opacity: 0;
          transform: translateX(-20px);
        }
        to {
          opacity: 1;
          transform: translateX(0);
        }
      }
      
      .section-number {
        opacity: 0;
      }
    `;
    document.head.appendChild(style);
  }

  sectionNumbers.forEach(num => numberObserver.observe(num));

  console.log('Magazine interactions loaded');

})();
