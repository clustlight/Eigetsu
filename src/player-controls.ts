import { useCallback, useEffect, useRef, useState } from 'react';
import type { HTMLAttributes, MouseEvent, SyntheticEvent } from 'react';

export const PLAYER_IDLE_MS = 2000;
const controlSelector = '[data-player-controls], button, input, select, textarea, label, a';

export function usePlayerControls(active = true): {
  visible: boolean;
  cursorHidden: boolean;
  canToggleFullscreen(event: MouseEvent<HTMLElement>): boolean;
  handlers: HTMLAttributes<HTMLElement>;
} {
  const [visible, setVisible] = useState(false);
  const [cursorHidden, setCursorHidden] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const visibleRef = useRef(false);
  const player = useRef<HTMLElement | null>(null);
  const pointerType = useRef<string | null>(null);
  const interacting = useRef(false);

  const changeVisibility = useCallback((value: boolean) => {
    visibleRef.current = value;
    setVisible(value);
  }, []);
  const armIdle = useCallback(() => {
    clearTimeout(timer.current);
    if (!active || interacting.current) return;
    timer.current = setTimeout(() => {
      const focused = document.activeElement;
      if (focused && player.current?.contains(focused) && focused.matches(':focus-visible')) return;
      changeVisibility(false);
      setCursorHidden(true);
    }, PLAYER_IDLE_MS);
  }, [active, changeVisibility]);

  useEffect(() => {
    interacting.current = false;
    changeVisibility(active);
    setCursorHidden(false);
    armIdle();
    const fullscreenChanged = () => {
      changeVisibility(active);
      setCursorHidden(false);
      armIdle();
    };
    document.addEventListener('fullscreenchange', fullscreenChanged);
    return () => {
      clearTimeout(timer.current);
      document.removeEventListener('fullscreenchange', fullscreenChanged);
    };
  }, [active, armIdle, changeVisibility]);

  const rememberPlayer = (event: SyntheticEvent<HTMLElement>) => {
    player.current = event.currentTarget;
  };
  const reveal = (event: SyntheticEvent<HTMLElement>) => {
    if (!active) return;
    rememberPlayer(event);
    changeVisibility(true);
    setCursorHidden(false);
    armIdle();
  };
  return {
    visible,
    cursorHidden,
    canToggleFullscreen: (event) =>
      pointerType.current !== 'touch' && !(event.target instanceof Element && event.target.closest(controlSelector)),
    handlers: {
      onPointerMove: (event) => {
        // Touch movement/leave events must not undo an explicit tap-to-hide.
        if (event.pointerType !== 'touch') reveal(event);
      },
      onPointerDown: (event) => {
        if (!active) return;
        rememberPlayer(event);
        pointerType.current = event.pointerType;
        setCursorHidden(false);
        if (event.target instanceof Element && event.target.closest(controlSelector)) {
          interacting.current = true;
          reveal(event);
        } else {
          changeVisibility(!visibleRef.current);
          armIdle();
        }
      },
      onPointerUp: () => {
        interacting.current = false;
        armIdle();
      },
      onPointerCancel: () => {
        interacting.current = false;
        armIdle();
      },
      onPointerLeave: (event) => {
        if (!active || interacting.current || event.pointerType === 'touch') return;
        clearTimeout(timer.current);
        changeVisibility(false);
        setCursorHidden(false);
      },
      onFocusCapture: (event) => {
        if (event.target instanceof Element && event.target.matches(':focus-visible')) reveal(event);
      },
      onBlurCapture: armIdle,
      onKeyDown: reveal,
    },
  };
}
