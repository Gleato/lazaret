import { BOB_MS, bungeeBob, fallCord, LONG_CORD, leapArc } from "../lib/bungee";

// The DOM half of the jumper (Bungee.astro). It only moves him: folder-ui.ts decides when. Every
// rest pose is CSS (--ax and friends on .bungee), so while he is still this file holds no state,
// and a deep link needs nothing from it. Motion is the same variables set inline, then removed.

const CROUCH_MS = 70;
// Hop plus free fall, up to where the long cord comes taut and takes the flap.
const LEAP_MS = 340;
const LEAP_RISE = 18;
// The share of the leap spent getting off the plank and flipping; the rest is falling.
const HOP_SHARE = 0.55;

function frames(ms: number, draw: (t: number) => void): Promise<void> {
  return new Promise((done) => {
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      draw(t);
      if (t < 1) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  });
}

export interface Jumper {
  /** Crouch, hop off the plank and free-fall until the long cord comes taut. */
  leap(): Promise<void>;
  /** Hang off the flap as it comes down. motion is the lid's own timing. */
  fall(tilt: number, motion: { duration: number; easing: string }): void;
  /** Bounce on the cord now the flap has landed. Not awaited, so tabs stay responsive. */
  bounce(): void;
}

export function initBungee(root: HTMLElement): Jumper | null {
  const rig = root.querySelector<HTMLElement>("[data-bungee]");
  const drop = rig?.querySelector<HTMLElement>("[data-drop]");
  if (!rig || !drop) return null;

  const set = (vars: Record<string, string>) => {
    for (const [name, value] of Object.entries(vars)) rig.style.setProperty(name, value);
  };
  // Rope lengths are screen px, but the rig is scaled, so they go in divided by the scale.
  const rope = (px: number) =>
    px / (Number.parseFloat(getComputedStyle(rig).getPropertyValue("--size")) || 1);

  return {
    async leap() {
      // Where CSS has him standing, so the sizes stay in one place.
      const css = getComputedStyle(rig);
      const fromX = Number.parseFloat(css.getPropertyValue("--ax"));
      const fromY = Number.parseFloat(css.getPropertyValue("--ay"));
      const taut = rope(LONG_CORD);

      rig.dataset.pose = "crouch";
      await new Promise((r) => setTimeout(r, CROUCH_MS));
      rig.dataset.pose = "dive";
      await frames(LEAP_MS, (t) => {
        const { along, lift, turn } = leapArc(Math.min(1, t / HOP_SHARE), LEAP_RISE);
        const x = fromX * (1 - along);
        // t squared: gravity, slow off the plank and quickening until the cord catches him.
        const y = fromY + (taut - fromY) * t * t - lift;
        // Only here is the cord off vertical: he starts along the plank from its ring.
        set({
          "--ax": `${x}px`,
          "--ay": `${y}px`,
          "--turn": `${turn}deg`,
          "--cord-len": `${Math.hypot(x, y)}px`,
          "--cord-turn": `${Math.atan2(-x, y)}rad`,
        });
      });
      rig.style.removeProperty("--cord-len");
      rig.style.removeProperty("--cord-turn");
    },

    fall(tilt, motion) {
      // The cord's ring rides the flap, but he must hang straight down the screen. So .drop turns
      // exactly the opposite way to the flap, on the same timing, and the two cancel out. Being
      // inside the flap's 3D space, he still gets its perspective and its travel for free.
      const turn = drop.animate(
        [{ transform: `rotateX(${-tilt}deg)` }, { transform: "rotateX(180deg)" }],
        motion,
      );
      // Timed from that animation, not a separate clock, so the cord can't drift from the flap.
      const pay = () => {
        // The pose goes when he lands: past that, a late frame would pin him in place.
        if (!rig.dataset.pose) return;
        const t = Number(turn.currentTime ?? 0) / motion.duration;
        set({ "--ay": `${rope(fallCord(t))}px` });
        if (t < 1) requestAnimationFrame(pay);
      };
      pay();
    },

    bounce() {
      // Set before the rest pose takes over, or he snaps up the stretch for a frame.
      set({ "--bob": `${bungeeBob(0)}px` });
      for (const name of ["--ax", "--ay", "--turn"]) rig.style.removeProperty(name);
      delete rig.dataset.pose;
      void frames(BOB_MS, (t) => {
        set({ "--bob": `${bungeeBob(t * BOB_MS)}px` });
      }).then(() => rig.style.removeProperty("--bob"));
    },
  };
}
