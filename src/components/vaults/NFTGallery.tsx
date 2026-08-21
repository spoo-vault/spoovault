import React, { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export const NFTGallery = ({ nfts }) => {
  const parentRef = useRef<HTMLDivElement>(null);
  const itemsPerRow = 3; // You can make this dynamic based on screen size
  const rowCount = Math.ceil(nfts.length / itemsPerRow);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 200, // Height of an NFT card row
  });

  return (
    <div ref={parentRef} className="h-[700px] overflow-auto">
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const startIndex = virtualRow.index * itemsPerRow;
          const itemsInRow = nfts.slice(startIndex, startIndex + itemsPerRow);

          return (
            <div
              key={virtualRow.key}
              className="grid grid-cols-3 gap-4"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {itemsInRow.map((nft, i) => (
                <div key={i} className="nft-card-container">
                   {/* Render your NFT component here */}
                   <img src={nft.image} alt={nft.name} className="rounded" />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
};