export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none" aria-hidden="true">
      <mask id="vo-logo-crossing" maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="256">
        <path fill="#fff" d="M0 0H256V256H0Z" />
        <path d="M123 160.256L149 105.837" stroke="#000" strokeWidth="40" />
      </mask>
      <path
        d="M30 66L84 177C91 192 107 193 115 177L158 87C166 70 177 62 192 62C213 62 228 79 228 101V153C228 176 213 194 192 194C176 194 165 185 157 169L136 125"
        stroke="#82ACEC"
        strokeWidth="28"
        strokeLinecap="round"
        strokeLinejoin="round"
        mask="url(#vo-logo-crossing)"
      />
      <path d="M122.5 161.302L149.5 104.791" stroke="#82ACEC" strokeWidth="28" />
    </svg>
  )
}
