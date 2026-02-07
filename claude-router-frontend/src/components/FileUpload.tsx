// src/components/FileUpload.tsx
// Multi-file upload component with L3 Safety Gates
// Supports multiple simultaneous file uploads with progress tracking

import React, { useRef, useState, useCallback } from 'react';
import type { FileUploadPayload } from '../types';

interface FileUploadProps {
  onFileContent: (file: FileUploadPayload) => void;
  onMultipleFiles?: (files: FileUploadPayload[]) => void; // New: batch callback
  disabled?: boolean;
  maxFiles?: number; // Default: 5
  maxTotalSize?: number; // Default: 50MB total
}

interface ProcessingState {
  total: number;
  completed: number;
  failed: number;
}

// Supported file types with their categories
const ACCEPTED_TYPES = {
  images: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  documents: ['text/plain', 'text/markdown', 'application/json', 'text/csv'],
  code: [
    'text/javascript', 'application/javascript',
    'text/typescript', 'application/typescript',
    'text/x-python', 'application/x-python'
  ]
};

const ACCEPT_STRING = [
  'image/*',
  '.txt', '.md', '.json', '.csv',
  '.py', '.ts', '.tsx', '.js', '.jsx',
  '.html', '.css', '.sql', '.yaml', '.yml'
].join(',');

export const FileUpload: React.FC<FileUploadProps> = ({ 
  onFileContent, 
  onMultipleFiles,
  disabled,
  maxFiles = 5,
  maxTotalSize = 50 * 1024 * 1024 // 50MB
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [processing, setProcessing] = useState<ProcessingState | null>(null);

  const handleClick = () => {
    if (!disabled && fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  /**
   * Process a single file and return a FileUploadPayload
   */
  const processFile = useCallback(async (file: File): Promise<FileUploadPayload | null> => {
    // L3 SAFETY GATE 1: Validate individual file size (10MB per file)
    const MAX_SINGLE_FILE = 10 * 1024 * 1024;
    if (file.size > MAX_SINGLE_FILE) {
      console.warn(`[FileUpload] File "${file.name}" exceeds 10MB limit`);
      return null;
    }

    const isImage = file.type.startsWith('image/');

    return new Promise((resolve) => {
      const reader = new FileReader();

      reader.onload = (event) => {
        const result = event.target?.result;

        // L3 SAFETY GATE 2: Validate read result
        if (!result) {
          console.error(`[FileUpload] Failed to read "${file.name}"`);
          resolve(null);
          return;
        }

        if (isImage) {
          // L3 SAFETY GATE 3: Validate base64 format for images
          if (typeof result !== 'string') {
            console.error(`[FileUpload] Invalid image data for "${file.name}"`);
            resolve(null);
            return;
          }

          const base64String = result.split(',')[1];
          if (!base64String) {
            console.error(`[FileUpload] Invalid base64 format for "${file.name}"`);
            resolve(null);
            return;
          }

          resolve({
            name: file.name,
            isImage: true,
            imageData: base64String,
            mediaType: file.type,
            size: file.size
          });
        } else {
          // L3 SAFETY GATE 4: Validate text content
          if (typeof result !== 'string') {
            console.error(`[FileUpload] Invalid text data for "${file.name}"`);
            resolve(null);
            return;
          }

          resolve({
            name: file.name,
            isImage: false,
            content: result,
            size: file.size
          });
        }
      };

      reader.onerror = () => {
        console.error(`[FileUpload] FileReader error for "${file.name}":`, reader.error);
        resolve(null);
      };

      // Read based on file type
      if (isImage) {
        reader.readAsDataURL(file);
      } else {
        reader.readAsText(file);
      }
    });
  }, []);

  /**
   * Handle multiple file selection
   */
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;

    // L3 SAFETY GATE 5: Validate files exist
    if (!files || files.length === 0) {
      console.warn('[FileUpload] No files selected');
      return;
    }

    // L3 SAFETY GATE 6: Validate file count
    if (files.length > maxFiles) {
      alert(`Too many files. Maximum is ${maxFiles} files at once.`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    // L3 SAFETY GATE 7: Validate total size
    const totalSize = Array.from(files).reduce((sum, f) => sum + f.size, 0);
    if (totalSize > maxTotalSize) {
      const maxMB = Math.round(maxTotalSize / (1024 * 1024));
      alert(`Total file size exceeds ${maxMB}MB limit.`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    // Initialize processing state
    setProcessing({ total: files.length, completed: 0, failed: 0 });

    try {
      const fileArray = Array.from(files);
      const results: FileUploadPayload[] = [];
      let failed = 0;

      // Process all files concurrently
      const promises = fileArray.map(async (file, index) => {
        const result = await processFile(file);
        
        setProcessing(prev => prev ? {
          ...prev,
          completed: prev.completed + 1,
          failed: prev.failed + (result ? 0 : 1)
        } : null);

        if (result) {
          results.push(result);
        } else {
          failed++;
        }
        
        return result;
      });

      await Promise.all(promises);

      // Deliver results
      if (results.length > 0) {
        if (onMultipleFiles && results.length > 1) {
          // Batch callback for multiple files
          onMultipleFiles(results);
        } else {
          // Individual callbacks (backwards compatible)
          results.forEach(file => onFileContent(file));
        }
      }

      // Report failures
      if (failed > 0) {
        const successCount = results.length;
        if (successCount > 0) {
          console.warn(`[FileUpload] ${failed} file(s) failed, ${successCount} succeeded`);
        } else {
          alert('All files failed to process. Please try again.');
        }
      }

    } catch (error) {
      console.error('[FileUpload] Unexpected error:', error);
      alert('An unexpected error occurred. Please try again.');
    } finally {
      // Clear input and processing state
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      // Small delay before clearing state for UX
      setTimeout(() => setProcessing(null), 500);
    }
  };

  const isProcessing = processing !== null;
  const progressPercent = processing 
    ? Math.round((processing.completed / processing.total) * 100)
    : 0;

  return (
    <>
      {/* Hidden native file input - now with multiple attribute */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_STRING}
        onChange={handleFileSelect}
        disabled={disabled || isProcessing}
        multiple // ✅ Enable multi-file selection
        className="file-input-hidden"
        aria-hidden="true"
        tabIndex={-1}
      />
      
      {/* Custom styled button with progress indicator */}
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || isProcessing}
        className={`file-upload-button ${isProcessing ? 'processing' : ''}`}
        title={isProcessing 
          ? `Processing ${processing?.completed}/${processing?.total} files...`
          : `Attach files (max ${maxFiles}, images or text)`
        }
        aria-label="Attach files"
      >
        {isProcessing ? (
          <div className="progress-indicator">
            <svg className="spinner" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" fill="none" strokeWidth="2" />
            </svg>
            <span className="progress-text">{progressPercent}%</span>
          </div>
        ) : (
          <svg 
            width="20" 
            height="20" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        )}
      </button>

      <style>{`
        .file-input-hidden {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border: 0;
        }

        .file-upload-button {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 44px;
          height: 44px;
          padding: 0;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 0.625rem;
          color: rgba(255, 255, 255, 0.6);
          cursor: pointer;
          transition: all 0.2s ease;
          flex-shrink: 0;
          position: relative;
        }

        .file-upload-button:hover:not(:disabled) {
          background: rgba(78, 205, 196, 0.1);
          border-color: rgba(78, 205, 196, 0.3);
          color: #4ECDC4;
        }

        .file-upload-button:focus {
          outline: none;
          box-shadow: 0 0 0 3px rgba(78, 205, 196, 0.2);
        }

        .file-upload-button:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        .file-upload-button.processing {
          background: rgba(78, 205, 196, 0.15);
          border-color: rgba(78, 205, 196, 0.4);
        }

        .file-upload-button svg:not(.spinner) {
          transition: transform 0.2s ease;
        }

        .file-upload-button:hover:not(:disabled) svg:not(.spinner) {
          transform: rotate(-10deg);
        }

        .progress-indicator {
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          width: 24px;
          height: 24px;
        }

        .spinner {
          width: 24px;
          height: 24px;
          animation: spin 1s linear infinite;
        }

        .spinner circle {
          stroke: #4ECDC4;
          stroke-dasharray: 50;
          stroke-dashoffset: 15;
          stroke-linecap: round;
        }

        .progress-text {
          position: absolute;
          font-size: 8px;
          font-weight: bold;
          color: #4ECDC4;
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </>
  );
};
