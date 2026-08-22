"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { gameAddress } from "~~/utils/red-light-green-block/contract";
import { TRACK_LENGTH } from "~~/utils/red-light-green-block/light";

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

  useEffect(() => {
    setPlayUrl(`${window.location.origin}/play`);
  }, []);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-neutral-950 p-8 text-white">
      <div className="text-center">
        <h1 className="text-6xl font-black tracking-tighter">
          RED LIGHT, <span className="text-green-400">GREEN BLOCK</span>
        </h1>
        <p className="mt-4 text-xl opacity-80">
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
        <Link href="/play" className="text-2xl font-bold text-green-400 underline">
          {playUrl ?? "/play"}
        </Link>
        <p className="mt-3 max-w-xl opacity-70">
          Scan it. You get a throwaway wallet and testnet gas automatically — no wallet install, no signature prompts.
          Then race {TRACK_LENGTH} steps. Step on a green block and you advance; step on a red one and you are out.
        </p>
      </div>

      <div className="flex gap-6 text-sm opacity-60">
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
          <span className="text-amber-400">contract not deployed yet</span>
        )}
      </div>
    </main>
  );
}
