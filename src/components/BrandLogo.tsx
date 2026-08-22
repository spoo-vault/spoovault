import { useState } from "react";

const SpooVaultFallback = ({
  className = "w-6 h-6",
}: {
  className?: string;
}) => (
  <svg viewBox="0 0 512 512" className={className} aria-hidden="true">
    <defs>
      <linearGradient id="sv-fb-purple" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#4c1d95" />
        <stop offset="50%" stopColor="#3b0764" />
        <stop offset="100%" stopColor="#2e1065" />
      </linearGradient>
      <linearGradient id="sv-fb-crimson" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#fb7185" />
        <stop offset="50%" stopColor="#e11d48" />
        <stop offset="100%" stopColor="#9f1239" />
      </linearGradient>
    </defs>
    <path
      d="M 256,42 C 340,42 410,72 440,96 C 440,240 390,380 256,470 C 122,380 72,240 72,96 C 102,72 172,42 256,42 Z"
      fill="url(#sv-fb-purple)"
      stroke="#6d28d9"
      strokeWidth="6"
    />
    <path
      d="M 256,70 C 322,70 378,94 405,114 C 405,230 362,345 256,425 C 150,345 107,230 107,114 C 134,94 190,70 256,70 Z"
      fill="none"
      stroke="url(#sv-fb-crimson)"
      strokeWidth="18"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M 370,140 C 290,120 170,165 170,230 C 170,290 342,260 342,330 C 342,390 220,410 142,375"
      fill="none"
      stroke="url(#sv-fb-purple)"
      strokeWidth="38"
      strokeLinecap="round"
    />
    <path
      d="M 370,140 C 290,120 170,165 170,230 C 170,290 342,260 342,330 C 342,390 220,410 142,375"
      fill="none"
      stroke="url(#sv-fb-crimson)"
      strokeWidth="14"
      strokeLinecap="round"
    />
    <circle cx="256" cy="240" r="24" fill="#ffffff" />
    <circle cx="256" cy="240" r="16" fill="#e11d48" />
    <path d="M 244,248 L 268,248 L 274,288 L 238,288 Z" fill="#e11d48" />
  </svg>
);

const BrandLogo = ({
  className = "w-6 h-6",
  alt = "SpooVault logo",
}: {
  className?: string;
  alt?: string;
}) => {
  const [src, setSrc] = useState("/spoovault-logo.png");
  const [useFallback, setUseFallback] = useState(false);

  if (!useFallback) {
    return (
      <img
        src={src}
        alt={alt}
        className={`${className} object-contain`}
        decoding="async"
        onError={() => {
          if (src !== "/spoovault-logo.svg") {
            setSrc("/spoovault-logo.svg");
            return;
          }
          setUseFallback(true);
        }}
      />
    );
  }

  return <SpooVaultFallback className={className} />;
};

export default BrandLogo;
