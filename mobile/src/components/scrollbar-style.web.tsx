export function ScrollbarStyle() {
  // Hide only the visual indicators, including those in multiline inputs.
  // Keep overflow and input behavior intact for wheel, touch, and keyboard use.
  return (
    <style>{`
      * { scrollbar-width: none; }
      *::-webkit-scrollbar { display: none; }
    `}</style>
  );
}
