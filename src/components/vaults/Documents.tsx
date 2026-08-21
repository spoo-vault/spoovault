import React, { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { DocumentCard } from './DocumentCard';

export const DocumentsList = ({ documents }) => {
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: documents.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 140, // Height of a document card + margin
    overscan: 5,
  });

  return (
    <div ref={parentRef} className="h-[600px] overflow-auto custom-scrollbar">
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualItem) => (
          <div
            key={virtualItem.key}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: `${virtualItem.size}px`,
              transform: `translateY(${virtualItem.start}px)`,
            }}
          >
            <DocumentCard document={documents[virtualItem.index]} />
          </div>
        ))}
      </div>
    </div>
  );
};