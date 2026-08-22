"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { gameAddress } from "~~/utils/red-light-green-block/contract";
import { TRACK_LENGTH } from "~~/utils/red-light-green-block/light";
import { LIGHT, MONAD } from "~~/utils/red-light-green-block/theme";

/**
 * The join screen, meant to be projected.
 *
 * The QR code is the entire onboarding funnel: scan, get a burner, get gas, play. It points at
 * `/play` on whatever origin is actually serving the page, so it works unchanged from a Vercel
 * deployment or from a laptop on the venue wifi — nobody has to remember to edit a URL when the
 * network turns out to be different from what was planned.
 */
export default function Home() {
  const [playUrl, setPlayUrl] = useState<string>();
  const address = gameAddress();
  const shortUrl = process.env.NEXT_PUBLIC_RLGB_SHORT_URL;

  useEffect(() => {
    setPlayUrl(`${window.location.origin}/play`);
  }, []);

  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center gap-8 p-8 text-white"
      style={{ backgroundColor: MONAD.black }}
    >
      <div className="text-center">
        {/* One "gmonad" is the whole in-joke. More would be trying too hard. */}
        <p className="mb-2 font-mono text-sm tracking-widest" style={{ color: MONAD.lightPurple }}>
          gmonad
        </p>
        <h1 className="text-6xl font-black tracking-tighter">
          RED LIGHT, <span style={{ color: LIGHT.green }}>GREEN BLOCK</span>
        </h1>
        <p className="mt-4 text-xl" style={{ color: MONAD.lightPurple }}>
          The traffic light is a pure function of the block number.
          <br />
          No server. No admin. No oracle. The chain is the referee.
        </p>
      </div>

      <div className="rounded-3xl bg-white p-6">
        {playUrl ? (
          <QRCodeSVG value={playUrl} size={280} />
        ) : (
          <div className="h-[280px] w-[280px] animate-pulse bg-neutral-200" />
        )}
      </div>

      <div className="text-center">
        {/* Three tiers, deliberately in this order.
            The QR above is the real path. Old phones and some camera apps refuse to scan, and a
            voter who cannot get in is a voter who never plays, so there are two text fallbacks.

            The short link is a THIRD-PARTY dependency sitting in the middle of the demo path. It
            was verified to resolve (one redirect, HTTP 200, ~1.4s versus ~120ms direct), but if
            that service is slow or down the link is dead — so it is labelled as a fallback, never
            the primary route, and the full address stays visible beneath it so nothing depends on
            a shortener alone. Set NEXT_PUBLIC_RLGB_SHORT_URL to change it, or leave it unset to
            drop the dependency entirely. */}
        {shortUrl && (
          <>
            <p className="text-sm uppercase tracking-widest" style={{ color: MONAD.lightPurple }}>
              or type this
            </p>
            <a
              href={shortUrl}
              className="mt-1 block font-mono text-4xl font-bold underline sm:text-5xl"
              style={{ color: MONAD.cyan }}
            >
              {shortUrl.replace(/^https?:\/\//, "")}
            </a>
          </>
        )}
        <Link
          href="/play"
          className="mt-2 block break-all font-mono text-sm underline opacity-60"
          style={{ color: MONAD.lightPurple }}
        >
          {playUrl ? playUrl.replace(/^https?:\/\//, "") : "/play"}
        </Link>
        <p className="mt-3 max-w-xl opacity-70">
          Scan it. You get a throwaway wallet and testnet gas automatically — no wallet install, no signature prompts.
          Then race {TRACK_LENGTH} steps. Step on a green block and you advance; step on a red one and you are out.
        </p>
      </div>

      <div className="flex gap-6 text-sm opacity-60">
        <Link href="/stage" className="underline">
          stage view
        </Link>
        <Link href="/debug" className="underline">
          debug contracts
        </Link>
        {address ? (
          <a
            href={`https://testnet.monadvision.com/address/${address}`}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            {address.slice(0, 10)}…{address.slice(-8)}
          </a>
        ) : (
          <span style={{ color: MONAD.lightPurple }}>contract not deployed yet</span>
        )}
      </div>
    </main>
  );
}
