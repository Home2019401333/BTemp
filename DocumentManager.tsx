import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '@/stores/settings'
import Button from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/Table'
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/Card'
import EmptyCard from '@/components/ui/EmptyCard'
import Checkbox from '@/components/ui/Checkbox'
import Input from '@/components/ui/Input'
import UploadDocumentsDialog from '@/components/documents/UploadDocumentsDialog'
import ClearDocumentsDialog from '@/components/documents/ClearDocumentsDialog'
import ChunkViewer from '@/components/documents/ChunkViewer'
import DeleteDocumentsDialog from '@/components/documents/DeleteDocumentsDialog'
import PaginationControls from '@/components/ui/PaginationControls'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/Dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/Tooltip'

import {
  scanNewDocuments,
  getDocumentsPaginatedWithTimeout,
  DocStatus,
  DocStatusResponse,
  DocumentsRequest,
  PaginationInfo
} from '@/api/lightrag'
import { errorMessage } from '@/lib/utils'
import { toast } from 'sonner'
import { copyToClipboard } from '@/utils/clipboard'

import { RefreshCwIcon, ActivityIcon, ArrowUpIcon, ArrowDownIcon, RotateCcwIcon, CheckSquareIcon, XIcon, AlertTriangle, Info, CopyIcon, SearchIcon } from 'lucide-react'
import PipelineStatusDialog from '@/components/documents/PipelineStatusDialog'
import {
  type StatusFilter
} from '@/features/documentStatusFilters'

// ── Display helpers (outside component — stable references, no closures) ──

type StatusDisplayConfig = {
  labelKey: string
  className: string
}

const getStatusDisplay = (status: DocStatus): StatusDisplayConfig => {
  switch (status) {
    case 'processed':
      return { labelKey: 'documentPanel.documentManager.status.completed', className: 'text-green-600' }
    case 'preprocessed':
      return { labelKey: 'documentPanel.documentManager.status.preprocessed', className: 'text-purple-600' }
    case 'parsing':
      return { labelKey: 'documentPanel.documentManager.status.parsing', className: 'text-cyan-600' }
    case 'analyzing':
      return { labelKey: 'documentPanel.documentManager.status.analyzing', className: 'text-indigo-600' }
    case 'processing':
      return { labelKey: 'documentPanel.documentManager.status.processing', className: 'text-blue-600' }
    case 'pending':
      return { labelKey: 'documentPanel.documentManager.status.pending', className: 'text-yellow-600' }
    case 'failed':
    default:
      return { labelKey: 'documentPanel.documentManager.status.failed', className: 'text-red-600' }
  }
}

// Backend status_counts uses lowercase keys (matching DocStatus.value).
const hasActiveDocumentsStatus = (counts: Record<string, number>): boolean =>
  (counts['processing'] ?? 0) > 0 ||
  (counts['parsing'] ?? 0) > 0 ||
  (counts['analyzing'] ?? 0) > 0 ||
  (counts['pending'] ?? 0) > 0 ||
  (counts['preprocessed'] ?? 0) > 0

const getDisplayFileName = (doc: DocStatusResponse, maxLength: number = 20): string => {
  if (!doc.file_path || typeof doc.file_path !== 'string' || doc.file_path.trim() === '') {
    return doc.id;
  }
  const parts = doc.file_path.split('/');
  const fileName = parts[parts.length - 1];
  if (!fileName || fileName.trim() === '') {
    return doc.id;
  }
  return fileName.length > maxLength
    ? fileName.slice(0, maxLength) + '...'
    : fileName;
};

const formatMetadata = (metadata: Record<string, any>): string => {
  const formattedMetadata = { ...metadata };
  const timeFields = ['parsing_start_time', 'analyzing_start_time', 'processing_start_time', 'processing_end_time'] as const;
  for (const field of timeFields) {
    if (formattedMetadata[field] && typeof formattedMetadata[field] === 'number') {
      const date = new Date(formattedMetadata[field] * 1000);
      if (!isNaN(date.getTime())) {
        formattedMetadata[field] = date.toLocaleString();
      }
    }
  }
  const jsonStr = JSON.stringify(formattedMetadata, null, 2);
  const lines = jsonStr.split('\n');
  return lines.slice(1, -1)
    .map(line => line.replace(/^ {2}/, ''))
    .join('\n');
};

const hasDocumentDetails = (doc: DocStatusResponse): boolean => {
  return Boolean(
    doc.track_id ||
    doc.error_msg ||
    (doc.metadata && Object.keys(doc.metadata).length > 0)
  )
}

const formatDocumentDetails = (doc: DocStatusResponse): string => {
  const details: string[] = []
  if (doc.track_id) {
    details.push(`Track ID: ${doc.track_id}`)
  }
  if (doc.metadata && Object.keys(doc.metadata).length > 0) {
    details.push(formatMetadata(doc.metadata))
  }
  if (doc.error_msg) {
    details.push(`Error Message:\n${doc.error_msg}`)
  }
  return details.join('\n\n')
}

const DocumentStatusDetailsDialog = ({ doc }: { doc: DocStatusResponse }) => {
  const { t } = useTranslation()
  const details = formatDocumentDetails(doc)
  const openLabel = t('documentPanel.documentManager.details.openTooltip')
  const copyLabel = t('documentPanel.documentManager.details.copyTooltip')

  const handleCopy = async () => {
    const result = await copyToClipboard(details)
    if (result.success) {
      toast.success(t('documentPanel.documentManager.details.copySuccess'))
    } else {
      toast.error(t('documentPanel.documentManager.details.copyFailed'))
    }
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-2 size-7"
          tooltip={openLabel}
          side="top"
          aria-label={openLabel}
        >
          {doc.error_msg ? (
            <AlertTriangle className="h-4 w-4 text-yellow-500" />
          ) : (
            <Info className="h-4 w-4 text-blue-500" />
          )}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-w-2xl"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement | null)?.focus()
        }}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('documentPanel.documentManager.details.title')}</DialogTitle>
          <DialogDescription className="break-all">
            {doc.id}
          </DialogDescription>
        </DialogHeader>
        <div className="relative rounded-md border bg-muted/30">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute top-2 right-2 z-10 size-7 bg-background/80 hover:bg-accent"
            onClick={handleCopy}
            tooltip={copyLabel}
            side="left"
            aria-label={copyLabel}
          >
            <CopyIcon className="h-4 w-4" />
          </Button>
          <div className="max-h-[60vh] overflow-y-auto p-3 pr-12">
            <pre className="whitespace-pre-wrap break-words text-sm">{details}</pre>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

const pulseStyle = `
@keyframes pulse {
  0% { background-color: rgb(255 0 0 / 0.1); border-color: rgb(255 0 0 / 0.2); }
  50% { background-color: rgb(255 0 0 / 0.2); border-color: rgb(255 0 0 / 0.4); }
  100% { background-color: rgb(255 0 0 / 0.1); border-color: rgb(255 0 0 / 0.2); }
}
.dark .pipeline-busy {
  animation: dark-pulse 2s infinite;
}
@keyframes dark-pulse {
  0% { background-color: rgb(255 0 0 / 0.2); border-color: rgb(255 0 0 / 0.4); }
  50% { background-color: rgb(255 0 0 / 0.3); border-color: rgb(255 0 0 / 0.6); }
  100% { background-color: rgb(255 0 0 / 0.2); border-color: rgb(255 0 0 / 0.4); }
}
.pipeline-busy {
  animation: pulse 2s infinite;
  border: 1px solid;
}
`;

// ── Types ──────────────────────────────────────────────────────────

type SortField = 'created_at' | 'updated_at' | 'id' | 'file_path';
type SortDirection = 'asc' | 'desc';

type DocumentManagerProps = {
  workspace: string
  onChunkViewChange?: (active: boolean) => void
}

// ── Component ──────────────────────────────────────────────────────

export default function DocumentManager({ workspace, onChunkViewChange }: DocumentManagerProps) {
  // Track component mount status — every timer callback checks this before
  // doing any work, so a stray fire after unmount is a no-op.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    const handleBeforeUnload = () => { isMountedRef.current = false; };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      isMountedRef.current = false;
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  // ── UI state ───────────────────────────────────────────────────
  const [showPipelineStatus, setShowPipelineStatus] = useState(false)
  const [view, setView] = useState<'list' | 'chunks'>('list')
  const [selectedDocForChunks, setSelectedDocForChunks] = useState<{
    docId: string
    fileName: string
  } | null>(null)
  const { t, i18n } = useTranslation()

  const currentTab = useSettingsStore.use.currentTab()
  const showFileName = useSettingsStore.use.showFileName()
  const setShowFileName = useSettingsStore.use.setShowFileName()
  const documentsPageSize = useSettingsStore.use.documentsPageSize()
  const setDocumentsPageSize = useSettingsStore.use.setDocumentsPageSize()

  // ── Document data state ────────────────────────────────────────
  const [currentPageDocs, setCurrentPageDocs] = useState<DocStatusResponse[]>([])
  const [pagination, setPagination] = useState<PaginationInfo>({
    page: 1,
    page_size: documentsPageSize,
    total_count: 0,
    total_pages: 0,
    has_next: false,
    has_prev: false
  })
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({ all: 0 })
  const statusCountsRef = useRef(statusCounts)
  useEffect(() => {
    statusCountsRef.current = statusCounts
  }, [statusCounts])

  const [isRefreshing, setIsRefreshing] = useState(false)

  // ── Sort state ─────────────────────────────────────────────────
  const [sortField, setSortField] = useState<SortField>('updated_at')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

  // ── Filter state ───────────────────────────────────────────────
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [pageByStatus, setPageByStatus] = useState<Record<StatusFilter, number>>({
    all: 1, processed: 1, analyzing: 1, processing: 1, pending: 1, failed: 1,
  });

  // ── Search state ───────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('')
  const searchQueryRef = useRef(searchQuery)
  useEffect(() => {
    searchQueryRef.current = searchQuery
  }, [searchQuery])

  // ── Selection state ────────────────────────────────────────────
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([])
  const isSelectionMode = selectedDocIds.length > 0

  // ── Refresh coordination refs ──────────────────────────────────
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const latestRefreshRequestVersionRef = useRef(0);
  // Throttle gate: enforces minimum 2s wall-clock interval between paginated calls.
  const lastPaginatedAtRef = useRef(0);
  const pendingPaginatedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Circuit breaker ────────────────────────────────────────────
  const [circuitBreakerState, setCircuitBreakerState] = useState({
    isOpen: false,
    failureCount: 0,
    lastFailureTime: null as number | null,
    nextRetryTime: null as number | null
  });
  // Mirror for async callbacks (polling interval) to avoid stale closures.
  const circuitBreakerRef = useRef(circuitBreakerState);
  useEffect(() => {
    circuitBreakerRef.current = circuitBreakerState;
  }, [circuitBreakerState]);

  // ── Document selection handlers ────────────────────────────────

  const handleDocumentSelect = (docId: string, checked: boolean) => {
    setSelectedDocIds(prev => {
      if (checked) return [...prev, docId]
      return prev.filter(id => id !== docId)
    })
  }

  const handleDeselectAll = () => {
    setSelectedDocIds([])
  }

  // ── Sort ───────────────────────────────────────────────────────

  const handleSort = (field: SortField) => {
    let actualField = field;
    if (field === 'id') {
      actualField = showFileName ? 'file_path' : 'id';
    }
    const newDirection = (sortField === actualField && sortDirection === 'desc') ? 'asc' : 'desc';
    setSortField(actualField);
    setSortDirection(newDirection);
    setPagination(prev => ({ ...prev, page: 1 }));
    setPageByStatus({
      all: 1, processed: 1, analyzing: 1, processing: 1, pending: 1, failed: 1,
    });
  };

  // ── Computed display values ────────────────────────────────────
  // Sorting is handled server-side; sortField/sortDirection changes trigger
  // a re-fetch via the central data-fetching effect.

  type DocStatusWithStatus = DocStatusResponse & { status: DocStatus };

  const filteredAndSortedDocs = useMemo(() => {
    if (currentPageDocs.length === 0) return []
    return currentPageDocs.map(doc => ({
      ...doc,
      status: doc.status as DocStatus
    })) as DocStatusWithStatus[];
  }, [currentPageDocs]);

  // Display counts derived from the single source of truth (API status_counts).
  // Backend returns lowercase keys; use ?? 0 for safety against missing keys.
  const displayCounts = useMemo(() => ({
    processed: statusCounts['processed'] ?? 0,
    analyzing:
      (statusCounts['parsing'] ?? 0) +
      (statusCounts['analyzing'] ?? 0) +
      (statusCounts['preprocessed'] ?? 0),
    processing: statusCounts['processing'] ?? 0,
    pending: statusCounts['pending'] ?? 0,
    failed: statusCounts['failed'] ?? 0,
  }), [statusCounts]);

  // ── Selection helpers ──────────────────────────────────────────

  const currentPageDocIds = useMemo(() => {
    return filteredAndSortedDocs?.map(doc => doc.id) || []
  }, [filteredAndSortedDocs])

  const selectedCurrentPageCount = useMemo(() => {
    return currentPageDocIds.filter(id => selectedDocIds.includes(id)).length
  }, [currentPageDocIds, selectedDocIds])

  const isCurrentPageFullySelected = useMemo(() => {
    return currentPageDocIds.length > 0 && selectedCurrentPageCount === currentPageDocIds.length
  }, [currentPageDocIds, selectedCurrentPageCount])

  const hasCurrentPageSelection = useMemo(() => {
    return selectedCurrentPageCount > 0
  }, [selectedCurrentPageCount])

  const handleSelectCurrentPage = useCallback(() => {
    setSelectedDocIds(currentPageDocIds)
  }, [currentPageDocIds])

  const getSelectionButtonProps = useCallback(() => {
    if (!hasCurrentPageSelection) {
      return {
        text: t('documentPanel.selectDocuments.selectCurrentPage', { count: currentPageDocIds.length }),
        action: handleSelectCurrentPage,
        icon: CheckSquareIcon
      }
    } else if (isCurrentPageFullySelected) {
      return {
        text: t('documentPanel.selectDocuments.deselectAll', { count: currentPageDocIds.length }),
        action: handleDeselectAll,
        icon: XIcon
      }
    } else {
      return {
        text: t('documentPanel.selectDocuments.selectCurrentPage', { count: currentPageDocIds.length }),
        action: handleSelectCurrentPage,
        icon: CheckSquareIcon
      }
    }
  }, [hasCurrentPageSelection, isCurrentPageFullySelected, currentPageDocIds.length, handleSelectCurrentPage, t])

  // ── Error handling ─────────────────────────────────────────────

  const classifyError = (error: any) => {
    if (error.name === 'AbortError') {
      return { type: 'cancelled', shouldRetry: false, shouldShowToast: false };
    }
    if (error.message === 'Request timeout') {
      return { type: 'timeout', shouldRetry: true, shouldShowToast: true };
    }
    if (error.message?.includes('Network Error') || error.code === 'NETWORK_ERROR') {
      return { type: 'network', shouldRetry: true, shouldShowToast: true };
    }
    if (error.status >= 500) {
      return { type: 'server', shouldRetry: true, shouldShowToast: true };
    }
    if (error.status >= 400 && error.status < 500) {
      return { type: 'client', shouldRetry: false, shouldShowToast: true };
    }
    return { type: 'unknown', shouldRetry: true, shouldShowToast: true };
  }

  // ── Circuit breaker ────────────────────────────────────────────

  const isCircuitBreakerOpen = () => {
    const state = circuitBreakerRef.current;
    if (!state.isOpen) return false;
    const now = Date.now();
    if (state.nextRetryTime && now >= state.nextRetryTime) {
      setCircuitBreakerState(prev => ({
        ...prev,
        isOpen: false,
        failureCount: Math.max(0, prev.failureCount - 1)
      }));
      return false;
    }
    return true;
  }

  const recordFailure = (_error: Error) => {
    const now = Date.now();
    setCircuitBreakerState(prev => {
      const newFailureCount = prev.failureCount + 1;
      const shouldOpen = newFailureCount >= 3;
      return {
        isOpen: shouldOpen,
        failureCount: newFailureCount,
        lastFailureTime: now,
        nextRetryTime: shouldOpen ? now + (Math.pow(2, newFailureCount) * 1000) : null
      };
    });
  }

  const recordSuccess = () => {
    setCircuitBreakerState({
      isOpen: false,
      failureCount: 0,
      lastFailureTime: null,
      nextRetryTime: null
    });
  }

  // ── Page size change ───────────────────────────────────────────

  const handlePageSizeChange = useCallback((newPageSize: number) => {
    if (newPageSize === pagination.page_size) return;
    setDocumentsPageSize(newPageSize);
    setPageByStatus({
      all: 1, processed: 1, analyzing: 1, processing: 1, pending: 1, failed: 1,
    });
    setPagination(prev => ({ ...prev, page: 1, page_size: newPageSize }));
  }, [pagination.page_size, setDocumentsPageSize]);

  const buildDocumentsRequest = (
    statusFilterValue: StatusFilter,
    page: number,
    pageSize: number,
    sortFieldValue: SortField,
    sortDirectionValue: SortDirection,
    fileName?: string | null
  ): DocumentsRequest => ({
    status_filter: statusFilterValue === 'all' ? null : statusFilterValue,
    page,
    page_size: pageSize,
    sort_field: sortFieldValue,
    sort_direction: sortDirectionValue,
    file_name: fileName || null
  })

  // ── Apply API response to state ────────────────────────────────

  const applyResponse = useCallback((response: { pagination: PaginationInfo; documents: DocStatusResponse[]; status_counts: Record<string, number> }) => {
    setPagination(response.pagination);
    setCurrentPageDocs(response.documents);
    setStatusCounts(response.status_counts);
  }, []);

  // ── Core refresh: fetch documents from API ─────────────────────

  const executeRefresh = useCallback(async (
    targetPage: number,
    targetStatusFilter: StatusFilter = statusFilter,
    targetFileName?: string | null,
    options?: { timeoutMs?: number }
  ) => {
    try {
      if (!isMountedRef.current) return;
      setIsRefreshing(true);

      const requestVersion = latestRefreshRequestVersionRef.current;
      const isStaleRequest = () => requestVersion !== latestRefreshRequestVersionRef.current;

      const currentPageSize = pagination.page_size;
      const fileName = targetFileName !== undefined ? targetFileName : searchQueryRef.current;

      const request = buildDocumentsRequest(
        targetStatusFilter, targetPage, currentPageSize, sortField, sortDirection, fileName
      );
      const response = await getDocumentsPaginatedWithTimeout(request, workspace, options?.timeoutMs);

      if (!isMountedRef.current || isStaleRequest()) return;

      // Boundary: empty page but data exists → fetch last page
      if (response.documents.length === 0 && response.pagination.total_count > 0) {
        const lastPage = Math.max(1, response.pagination.total_pages);
        if (targetPage !== lastPage) {
          const lastPageRequest = buildDocumentsRequest(
            targetStatusFilter, lastPage, currentPageSize, sortField, sortDirection, fileName
          );
          const lastPageResponse = await getDocumentsPaginatedWithTimeout(lastPageRequest, workspace, options?.timeoutMs);
          if (!isMountedRef.current || isStaleRequest()) return;
          setPageByStatus(prev => ({ ...prev, [targetStatusFilter]: lastPage }));
          applyResponse(lastPageResponse);
          return;
        }
      }

      // Page 1 size adjustment: if results fit in smaller page, switch to page size 10
      if (targetPage === 1 && response.pagination.total_count < currentPageSize && currentPageSize !== 10) {
        handlePageSizeChange(10);
      } else {
        applyResponse(response);
      }

      setPageByStatus(prev => (
        prev[targetStatusFilter] === targetPage ? prev : { ...prev, [targetStatusFilter]: targetPage }
      ));

    } catch (err) {
      if (isMountedRef.current) {
        const classification = classifyError(err);
        if (classification.shouldShowToast) {
          toast.error(t('documentPanel.documentManager.errors.loadFailed', { error: errorMessage(err) }));
        }
        if (classification.shouldRetry) {
          recordFailure(err as Error);
        }
      }
    } finally {
      if (isMountedRef.current) {
        setIsRefreshing(false);
      }
    }
  }, [workspace, statusFilter, pagination.page_size, sortField, sortDirection, applyResponse, handlePageSizeChange, t]);

  // ── Throttled refresh (auto-polling entry point, 2s minimum gap) ──

  const refreshDocumentsThrottled = useCallback(() => {
    const fire = () => {
      lastPaginatedAtRef.current = Date.now()
      executeRefresh(pagination.page).catch((err) => {
        console.error('Throttled document refresh failed:', err)
      })
    }
    const gap = Date.now() - lastPaginatedAtRef.current
    if (gap >= 2000) {
      fire()
      return
    }
    if (pendingPaginatedTimerRef.current !== null) return
    const versionAtSchedule = latestRefreshRequestVersionRef.current
    pendingPaginatedTimerRef.current = setTimeout(() => {
      pendingPaginatedTimerRef.current = null
      if (!isMountedRef.current) return
      if (versionAtSchedule !== latestRefreshRequestVersionRef.current) return
      fire()
    }, 2000 - gap)
  }, [executeRefresh, pagination.page]);

  // ── Force refresh (bypasses throttle — used after upload for instant feedback) ──

  const forceRefreshDocuments = useCallback(async () => {
    lastPaginatedAtRef.current = 0
    await executeRefresh(1)
  }, [executeRefresh])

  // ── Polling interval management ────────────────────────────────

  const clearPollingInterval = () => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  }

  const startPollingInterval = useCallback((intervalMs: number) => {
    clearPollingInterval();
    pollingIntervalRef.current = setInterval(() => {
      if (!isMountedRef.current) return;
      if (isCircuitBreakerOpen()) return;
      refreshDocumentsThrottled();
      recordSuccess();
    }, intervalMs);
  }, [refreshDocumentsThrottled]);

  // ── Scan documents ─────────────────────────────────────────────

  const scanDocuments = useCallback(async () => {
    try {
      if (!isMountedRef.current) return;
      const { status, message } = await scanNewDocuments(workspace);
      if (!isMountedRef.current) return;
      toast.message(message || status);
      // Immediate refresh — the polling loop handles subsequent updates
      refreshDocumentsThrottled();
    } catch (err) {
      if (isMountedRef.current) {
        toast.error(t('documentPanel.documentManager.errors.scanFailed', { error: errorMessage(err) }));
      }
    }
  }, [t, refreshDocumentsThrottled, workspace])

  // ── Manual refresh button ──────────────────────────────────────

  const handleManualRefresh = useCallback(async () => {
    await executeRefresh(1)
  }, [executeRefresh]);

  // ── Bump version when query parameters change ──────────────────

  useEffect(() => {
    latestRefreshRequestVersionRef.current += 1
  }, [workspace, pagination.page, pagination.page_size, statusFilter, sortField, sortDirection])

  // ── Reset state on workspace change ────────────────────────────

  useEffect(() => {
    setCurrentPageDocs([])
    setSelectedDocIds([])
    setStatusCounts({ all: 0 })
    setPagination((prev) => ({ ...prev, page: 1, total_count: 0, total_pages: 0, has_next: false, has_prev: false }))
  }, [workspace])

  // ── Dynamic polling based on document activity ─────────────────
  // 5s when documents are being processed, 30s when idle.

  useEffect(() => {
    if (currentTab !== 'knowledge-base') {
      clearPollingInterval();
      return
    }
    const hasActiveDocuments = hasActiveDocumentsStatus(statusCounts);
    const pollingInterval = hasActiveDocuments ? 5000 : 30000;
    startPollingInterval(pollingInterval);
    return () => {
      clearPollingInterval();
    }
  }, [currentTab, statusCounts, startPollingInterval])

  // ── Central data-fetching effect ───────────────────────────────

  const fetchPaginatedDocuments = useCallback(async (
    page: number,
    pageSize: number,
    currentStatusFilter: StatusFilter
  ) => {
    setPagination(prev => ({ ...prev, page, page_size: pageSize }));
    await executeRefresh(page, currentStatusFilter);
  }, [executeRefresh]);

  useEffect(() => {
    if (currentTab === 'knowledge-base') {
      fetchPaginatedDocuments(pagination.page, pagination.page_size, statusFilter);
    }
  }, [
    currentTab,
    workspace,
    pagination.page,
    pagination.page_size,
    statusFilter,
    sortField,
    sortDirection,
    fetchPaginatedDocuments
  ]);

  // ── Page / filter change handlers ──────────────────────────────

  const handlePageChange = useCallback((newPage: number) => {
    if (newPage === pagination.page) return;
    setPageByStatus(prev => ({ ...prev, [statusFilter]: newPage }));
    setPagination(prev => ({ ...prev, page: newPage }));
  }, [pagination.page, statusFilter]);

  const handleStatusFilterChange = useCallback((newStatusFilter: StatusFilter) => {
    if (newStatusFilter === statusFilter) return;
    setPageByStatus(prev => ({ ...prev, [statusFilter]: pagination.page }));
    const newPage = pageByStatus[newStatusFilter];
    setStatusFilter(newStatusFilter);
    setPagination(prev => ({ ...prev, page: newPage }));
  }, [statusFilter, pagination.page, pageByStatus]);

  // ── Callbacks from child dialogs ───────────────────────────────

  const handleDocumentsDeleted = useCallback(async () => {
    setSelectedDocIds([])
    startPollingInterval(2000)
  }, [startPollingInterval])

  const handleDocumentsCleared = useCallback(async () => {
    clearPollingInterval();
    setStatusCounts({
      all: 0, processed: 0, preprocessed: 0, parsing: 0,
      analyzing: 0, processing: 0, pending: 0, failed: 0
    });
    if (isMountedRef.current) {
      try {
        await executeRefresh(1);
      } catch (err) {
        console.error('Error fetching documents after clear:', err);
      }
    }
    if (currentTab === 'knowledge-base' && isMountedRef.current) {
      startPollingInterval(30000);
    }
  }, [startPollingInterval, currentTab, executeRefresh])

  // ── showFileName toggle ────────────────────────────────────────

  const [previousShowFileName, setPreviousShowFileName] = useState(showFileName)
  if (showFileName !== previousShowFileName) {
    setPreviousShowFileName(showFileName)
    if (sortField === 'id' || sortField === 'file_path') {
      const newSortField = showFileName ? 'file_path' : 'id';
      if (sortField !== newSortField) {
        setSortField(newSortField);
      }
    }
  }

  // ── Reset selection on page/filter/sort changes (render-time) ──

  const [previousSelectionDeps, setPreviousSelectionDeps] = useState({
    page: pagination.page, statusFilter, sortField, sortDirection
  })
  if (
    previousSelectionDeps.page !== pagination.page ||
    previousSelectionDeps.statusFilter !== statusFilter ||
    previousSelectionDeps.sortField !== sortField ||
    previousSelectionDeps.sortDirection !== sortDirection
  ) {
    setPreviousSelectionDeps({
      page: pagination.page, statusFilter, sortField, sortDirection
    })
    setSelectedDocIds([])
  }

  // ── Inject pulse CSS ───────────────────────────────────────────

  useEffect(() => {
    const style = document.createElement('style')
    style.textContent = pulseStyle
    document.head.appendChild(style)
    return () => {
      document.head.removeChild(style)
    }
  }, [])

  // ── Chunk viewer mode ──────────────────────────────────────────

  if (view === 'chunks' && selectedDocForChunks) {
    return (
      <ChunkViewer
        workspace={workspace}
        docId={selectedDocForChunks.docId}
        docFileName={selectedDocForChunks.fileName}
        onBack={() => {
          setView('list')
          setSelectedDocForChunks(null)
          onChunkViewChange?.(false)
        }}
      />
    )
  }

  // ── Render ─────────────────────────────────────────────────────
  // Show empty state when there are no documents at all (not just
  // an empty current page — check the total count).

  const isEmpty = statusCounts.all === 0 && currentPageDocs.length === 0

  return (
    <Card className="!rounded-none !overflow-hidden flex flex-col h-full min-h-0">
      <CardContent className="flex-1 flex flex-col min-h-0 overflow-auto px-6 py-2">
        <div className="flex justify-between items-center gap-2 mb-2">
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={scanDocuments}
              side="bottom"
              tooltip={t('documentPanel.documentManager.scanTooltip')}
              size="sm"
            >
              <RefreshCwIcon /> {t('documentPanel.documentManager.scanButton')}
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowPipelineStatus(true)}
              side="bottom"
              tooltip={t('documentPanel.documentManager.pipelineStatusTooltip')}
              size="sm"
            >
              <ActivityIcon /> {t('documentPanel.documentManager.pipelineStatusButton')}
            </Button>
          </div>

          {pagination.total_pages > 1 && (
            <PaginationControls
              currentPage={pagination.page}
              totalPages={pagination.total_pages}
              pageSize={pagination.page_size}
              totalCount={pagination.total_count}
              onPageChange={handlePageChange}
              onPageSizeChange={handlePageSizeChange}
              isLoading={isRefreshing}
              compact={true}
            />
          )}

          <div className="flex gap-2">
            <Button
              id="toggle-filename-btn"
              variant="outline"
              size="sm"
              onClick={() => setShowFileName(!showFileName)}
              className="border-border hover:bg-accent"
            >
              {showFileName
                ? t('documentPanel.documentManager.hideButton') + t('documentPanel.documentManager.fileNameLabel')
                : t('documentPanel.documentManager.showButton') + t('documentPanel.documentManager.fileNameLabel')
              }
            </Button>
            {isSelectionMode && (
              <DeleteDocumentsDialog
                workspace={workspace}
                selectedDocIds={selectedDocIds}
                onDocumentsDeleted={handleDocumentsDeleted}
              />
            )}
            {isSelectionMode && hasCurrentPageSelection ? (
              (() => {
                const buttonProps = getSelectionButtonProps();
                const IconComponent = buttonProps.icon;
                return (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={buttonProps.action}
                    side="bottom"
                    tooltip={buttonProps.text}
                  >
                    <IconComponent className="h-4 w-4" />
                    {buttonProps.text}
                  </Button>
                );
              })()
            ) : !isSelectionMode ? (
              <ClearDocumentsDialog workspace={workspace} onDocumentsCleared={handleDocumentsCleared} />
            ) : null}
            <UploadDocumentsDialog
              workspace={workspace}
              onUploadBatchAccepted={() => refreshDocumentsThrottled()}
              onDocumentsUploaded={forceRefreshDocuments}
            />
            <PipelineStatusDialog
              open={showPipelineStatus}
              onOpenChange={setShowPipelineStatus}
            />
          </div>
        </div>

        <Card className="flex-1 flex flex-col border rounded-md min-h-0 mb-2">
          <CardHeader className="flex-none py-2 px-4 relative">
            <div className="flex items-center gap-2">
              <CardTitle className="shrink-0">{t('documentPanel.documentManager.uploadedTitle')}</CardTitle>
              <div className="flex-1 flex items-center justify-center gap-2">
                <div className="flex gap-1" dir={i18n.dir()}>
                  <Button
                    size="sm"
                    variant={statusFilter === 'all' ? 'secondary' : 'outline'}
                    onClick={() => handleStatusFilterChange('all')}
                    disabled={isRefreshing}
                    className={cn(
                      statusFilter === 'all' && 'bg-accent text-accent-foreground font-medium border-border shadow-sm'
                    )}
                  >
                    {t('documentPanel.documentManager.filters.all')} ({statusCounts.all ?? 0})
                  </Button>
                  <Button
                    size="sm"
                    variant={statusFilter === 'processed' ? 'secondary' : 'outline'}
                    onClick={() => handleStatusFilterChange('processed')}
                    disabled={isRefreshing}
                    className={cn(
                      displayCounts.processed > 0 ? 'text-green-600' : 'text-muted-foreground',
                      statusFilter === 'processed' && 'bg-green-100 dark:bg-green-900/30 font-medium border border-green-400 dark:border-green-600 shadow-sm'
                    )}
                  >
                    {t('documentPanel.documentManager.filters.completed')} ({displayCounts.processed})
                  </Button>
                  <Button
                    size="sm"
                    variant={statusFilter === 'analyzing' ? 'secondary' : 'outline'}
                    onClick={() => handleStatusFilterChange('analyzing')}
                    disabled={isRefreshing}
                    className={cn(
                      displayCounts.analyzing > 0 ? 'text-indigo-600' : 'text-muted-foreground',
                      statusFilter === 'analyzing' && 'bg-indigo-100 dark:bg-indigo-900/30 font-medium border border-indigo-400 dark:border-indigo-600 shadow-sm'
                    )}
                  >
                    {t('documentPanel.documentManager.filters.analyzing')} ({displayCounts.analyzing})
                  </Button>
                  <Button
                    size="sm"
                    variant={statusFilter === 'processing' ? 'secondary' : 'outline'}
                    onClick={() => handleStatusFilterChange('processing')}
                    disabled={isRefreshing}
                    className={cn(
                      displayCounts.processing > 0 ? 'text-blue-600' : 'text-muted-foreground',
                      statusFilter === 'processing' && 'bg-blue-100 dark:bg-blue-900/30 font-medium border border-blue-400 dark:border-blue-600 shadow-sm'
                    )}
                  >
                    {t('documentPanel.documentManager.filters.processing')} ({displayCounts.processing})
                  </Button>
                  <Button
                    size="sm"
                    variant={statusFilter === 'pending' ? 'secondary' : 'outline'}
                    onClick={() => handleStatusFilterChange('pending')}
                    disabled={isRefreshing}
                    className={cn(
                      displayCounts.pending > 0 ? 'text-yellow-600' : 'text-muted-foreground',
                      statusFilter === 'pending' && 'bg-yellow-100 dark:bg-yellow-900/30 font-medium border border-yellow-400 dark:border-yellow-600 shadow-sm'
                    )}
                  >
                    {t('documentPanel.documentManager.filters.pending')} ({displayCounts.pending})
                  </Button>
                  <Button
                    size="sm"
                    variant={statusFilter === 'failed' ? 'secondary' : 'outline'}
                    onClick={() => handleStatusFilterChange('failed')}
                    disabled={isRefreshing}
                    className={cn(
                      displayCounts.failed > 0 ? 'text-red-600' : 'text-muted-foreground',
                      statusFilter === 'failed' && 'bg-red-100 dark:bg-red-900/30 font-medium border border-red-400 dark:border-red-600 shadow-sm'
                    )}
                  >
                    {t('documentPanel.documentManager.filters.failed')} ({displayCounts.failed})
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleManualRefresh}
                  disabled={isRefreshing}
                  side="bottom"
                  tooltip={t('documentPanel.documentManager.refreshTooltip')}
                >
                  <RotateCcwIcon className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="absolute right-4 top-1/2 -translate-y-1/2">
              <SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none z-10" />
              <Input
                className="h-8 pl-7 pr-2 w-56 text-sm"
                placeholder={t('documentPanel.documentManager.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const value = (e.target as HTMLInputElement).value
                    setPagination(prev => ({ ...prev, page: 1 }))
                    executeRefresh(1, statusFilter, value)
                  }
                }}
              />
            </div>
            <CardDescription aria-hidden="true" className="hidden">{t('documentPanel.documentManager.uploadedDescription')}</CardDescription>
          </CardHeader>

          <CardContent className="min-h-0 flex-1 relative p-0">
            {isEmpty && (
              <div className="absolute inset-0 min-h-0 p-0">
                <EmptyCard
                  title={t('documentPanel.documentManager.emptyTitle')}
                  description={t('documentPanel.documentManager.emptyDescription')}
                />
              </div>
            )}
            {!isEmpty && (
              <div className="absolute inset-0 flex min-h-0 flex-col p-0">
                <div className="absolute inset-[-1px] flex flex-col p-0 border rounded-md border-border overflow-hidden">
                  <TooltipProvider>
                    <Table className="w-full">
                      <TableHeader className="sticky top-0 bg-background z-10 shadow-sm">
                        <TableRow className="border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/75 shadow-[inset_0_-1px_0_rgba(0,0,0,0.1)]">
                          <TableHead
                            onClick={() => handleSort('id')}
                            className="cursor-pointer hover:bg-accent select-none"
                          >
                            <div className="flex items-center">
                              {showFileName
                                ? t('documentPanel.documentManager.columns.fileName')
                                : t('documentPanel.documentManager.columns.id')
                              }
                              {((sortField === 'id' && !showFileName) || (sortField === 'file_path' && showFileName)) && (
                                <span className="ml-1">
                                  {sortDirection === 'asc' ? <ArrowUpIcon size={14} /> : <ArrowDownIcon size={14} />}
                                </span>
                              )}
                            </div>
                          </TableHead>
                          <TableHead>{t('documentPanel.documentManager.columns.summary')}</TableHead>
                          <TableHead>{t('documentPanel.documentManager.columns.status')}</TableHead>
                          <TableHead>{t('documentPanel.documentManager.columns.length')}</TableHead>
                          <TableHead>{t('documentPanel.documentManager.columns.chunks')}</TableHead>
                          <TableHead
                            onClick={() => handleSort('created_at')}
                            className="cursor-pointer hover:bg-accent select-none"
                          >
                            <div className="flex items-center">
                              {t('documentPanel.documentManager.columns.created')}
                              {sortField === 'created_at' && (
                                <span className="ml-1">
                                  {sortDirection === 'asc' ? <ArrowUpIcon size={14} /> : <ArrowDownIcon size={14} />}
                                </span>
                              )}
                            </div>
                          </TableHead>
                          <TableHead
                            onClick={() => handleSort('updated_at')}
                            className="cursor-pointer hover:bg-accent select-none"
                          >
                            <div className="flex items-center">
                              {t('documentPanel.documentManager.columns.updated')}
                              {sortField === 'updated_at' && (
                                <span className="ml-1">
                                  {sortDirection === 'asc' ? <ArrowUpIcon size={14} /> : <ArrowDownIcon size={14} />}
                                </span>
                              )}
                            </div>
                          </TableHead>
                          <TableHead className="w-16 text-center">
                            {t('documentPanel.documentManager.columns.select')}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody className="text-sm overflow-auto">
                        {filteredAndSortedDocs.map((doc) => (
                          <TableRow
                            key={doc.id}
                            className={doc.status === 'processed' ? 'cursor-pointer hover:bg-accent/50' : ''}
                            onDoubleClick={() => {
                              if (doc.status === 'processed') {
                                setSelectedDocForChunks({
                                  docId: doc.id,
                                  fileName: getDisplayFileName(doc, 60)
                                })
                                setView('chunks')
                                onChunkViewChange?.(true)
                              }
                            }}
                          >
                            <TableCell className="truncate font-mono overflow-visible max-w-[250px]">
                              {showFileName ? (
                                <>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <div className="truncate">
                                        {getDisplayFileName(doc, 30)}
                                      </div>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-2xl">
                                      {doc.file_path}
                                    </TooltipContent>
                                  </Tooltip>
                                  <div className="text-xs text-muted-foreground">{doc.id}</div>
                                </>
                              ) : (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <div className="truncate">
                                      {doc.id}
                                    </div>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="max-w-2xl">
                                    {doc.file_path}
                                  </TooltipContent>
                                </Tooltip>
                              )}
                            </TableCell>
                            <TableCell className="max-w-xs min-w-45 truncate overflow-visible">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div className="truncate">
                                    {doc.content_summary}
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-2xl">
                                  {doc.content_summary}
                                </TooltipContent>
                              </Tooltip>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center">
                                {(() => {
                                  const statusDisplay = getStatusDisplay(doc.status)
                                  return (
                                    <span className={statusDisplay.className}>
                                      {t(statusDisplay.labelKey)}
                                    </span>
                                  )
                                })()}
                                {hasDocumentDetails(doc) && <DocumentStatusDetailsDialog doc={doc} />}
                              </div>
                            </TableCell>
                            <TableCell>{doc.content_length ?? '-'}</TableCell>
                            <TableCell>{doc.chunks_count ?? '-'}</TableCell>
                            <TableCell className="truncate">
                              {new Date(doc.created_at).toLocaleString()}
                            </TableCell>
                            <TableCell className="truncate">
                              {new Date(doc.updated_at).toLocaleString()}
                            </TableCell>
                            <TableCell className="text-center">
                              <Checkbox
                                checked={selectedDocIds.includes(doc.id)}
                                onCheckedChange={(checked) => handleDocumentSelect(doc.id, checked === true)}
                                className="mx-auto"
                              />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TooltipProvider>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </CardContent>
    </Card>
  )
}
