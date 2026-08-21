import React, { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export const AuditLogTimeline = ({ logs }) => {
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: logs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80, // Logs are usually smaller than document cards
    overscan: 10,
  });

  return (
    <div ref={parentRef} className="h-[400px] overflow-auto">
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: `${virtualRow.size}px`,
              transform: `translateY(${virtualRow.start}px)`,
              padding: '8px 0'
            }}
          >
            <div className="border-l-2 border-primary-500 pl-4">
              <p className="text-sm font-bold">{logs[virtualRow.index].action}</p>
              <p className="text-xs text-gray-500">{logs[virtualRow.index].timestamp}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};