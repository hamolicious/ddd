import { useEffect, useState } from "react";

const KEYBOARD_SHARE = 0.8;

export function keyboardCovers(height: number, tallest: number): boolean {
  return tallest > 0 && height < tallest * KEYBOARD_SHARE;
}

function typingInto(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  return element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement;
}

export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const viewport = window.visualViewport;
    let width = window.innerWidth;
    let tallest = 0;

    const update = (): void => {
      if (window.innerWidth !== width) {
        width = window.innerWidth;
        tallest = 0;
      }
      const height = viewport?.height ?? window.innerHeight;
      tallest = Math.max(tallest, height, window.innerHeight);
      setOpen(typingInto(document.activeElement) && keyboardCovers(height, tallest));
    };

    update();
    viewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
    };
  }, []);

  return open;
}
