/**
 * ImportModal — source chooser + steps orchestration for schedule import.
 * 导入弹窗 — 课表导入的来源选择和步骤编排。
 */
import { useState, useCallback } from 'react';
import { Modal, Stack, Button, Group, Text, Stepper, Alert, TextInput } from '@mantine/core';
import { FileSpreadsheet, FileText, ImageIcon, Globe, AlertCircle, ExternalLink } from 'lucide-react';
import { t, useI18n } from '../../../i18n/index.ts';
import type { ScheduleDataSource } from '../data/scheduleElectronDataSource.ts';
import type { ScheduleImportDraft, ScheduleImportPreviewResult, ScheduleImportCommitResult } from '../../../../shared/schedule.ts';
import ImportPreviewTable from './ImportPreviewTable.tsx';

interface ImportModalProps {
  opened: boolean;
  onClose: () => void;
  dataSource: ScheduleDataSource;
  onImported?: () => void;
}

type ImportSource = 'csv' | 'excel' | 'image' | 'url' | 'browser';

export default function ImportModal({ opened, onClose, dataSource, onImported }: ImportModalProps) {
  useI18n();
  const [step, setStep] = useState(0);
  const [source, setSource] = useState<ImportSource | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<ScheduleImportDraft[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [result, setResult] = useState<ScheduleImportCommitResult | null>(null);

  const reset = useCallback(() => {
    setStep(0);
    setSource(null);
    setFilePath(null);
    setUrlInput('');
    setLoading(false);
    setError(null);
    setDrafts([]);
    setWarnings([]);
    setResult(null);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  // Step 1: Pick file
  const handlePickFile = useCallback(async (kind: ImportSource) => {
    setSource(kind);
    setLoading(true);
    setError(null);

    try {
      const path = await dataSource.importPickFile(kind);
      if (!path) {
        setLoading(false);
        return;
      }
      setFilePath(path);

      let preview: ScheduleImportPreviewResult;
      if (kind === 'csv') {
        preview = await dataSource.importPreviewCsv(path);
      } else if (kind === 'excel') {
        preview = await dataSource.importPreviewExcel(path);
      } else if (kind === 'image') {
        preview = await dataSource.importPreviewImage(path);
      } else {
        setLoading(false);
        return;
      }

      if (preview.status === 'ok') {
        setDrafts(preview.draft);
        setWarnings(preview.warnings);
        setStep(2);
      } else {
        setError(preview.message);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [dataSource]);

  // URL import handler
  const handleUrlImport = useCallback(async () => {
    if (!urlInput.trim()) {
      setError('请输入网址。');
      return;
    }
    setSource('url');
    setFilePath(urlInput.trim());
    setLoading(true);
    setError(null);

    try {
      const preview = await dataSource.importPreviewUrl(urlInput.trim());
      if (preview.status === 'ok') {
        setDrafts(preview.draft);
        setWarnings(preview.warnings);
        setStep(2);
      } else {
        setError(preview.message);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [urlInput, dataSource]);

  // Browser login handler
  const handleBrowserLogin = useCallback(async () => {
    const url = urlInput.trim() || 'https://jwxt.edu.cn';
    setSource('browser');
    setFilePath(url);
    setLoading(true);
    setError(null);

    try {
      const preview = await dataSource.importOpenBrowser(url);
      if (preview.status === 'ok') {
        setDrafts(preview.draft);
        setWarnings(preview.warnings);
        setStep(2);
      } else {
        setError(preview.message);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [urlInput, dataSource]);

  // Step 3: Commit
  const handleCommit = useCallback(async () => {
    if (!source || !filePath) return;
    setLoading(true);
    setError(null);

    try {
      const validDrafts = drafts.filter(d => d.valid);
      const commitResult = await dataSource.importCommit({
        drafts: validDrafts,
        sourceType: source,
        sourceLabel: filePath.split(/[/\\]/).pop() ?? filePath,
      });
      setResult(commitResult);
      setStep(3);
      onImported?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [source, filePath, drafts, dataSource, onImported]);

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title={t('导入课表')}
      size="xl"
    >
      <Stepper active={step} onStepClick={setStep}>
        <Stepper.Step label={t('选择来源')}>
          <Stack gap="md" py="md">
            <Text size="sm" c="dimmed">{t('选择课表导入方式')}</Text>
            <Group grow>
              <Button
                variant="light"
                leftSection={<FileText size={18} />}
                onClick={() => handlePickFile('csv')}
                loading={loading && source === 'csv'}
              >
                CSV / TSV
              </Button>
              <Button
                variant="light"
                leftSection={<FileSpreadsheet size={18} />}
                onClick={() => handlePickFile('excel')}
                loading={loading && source === 'excel'}
              >
                Excel (.xlsx)
              </Button>
              <Button
                variant="light"
                leftSection={<ImageIcon size={18} />}
                onClick={() => handlePickFile('image')}
                loading={loading && source === 'image'}
              >
                {t('图片')} (AI)
              </Button>
            </Group>

            <Text size="sm" c="dimmed" mt="md">{t('从网页导入')}</Text>
            <Stack gap="xs">
              <Group>
                <TextInput
                  placeholder={t('输入课表网页地址（如教务系统）')}
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.currentTarget.value)}
                  style={{ flex: 1 }}
                  leftSection={<Globe size={16} />}
                />
              </Group>
              <Group grow>
                <Button
                  variant="light"
                  leftSection={<Globe size={16} />}
                  onClick={handleUrlImport}
                  loading={loading && source === 'url'}
                >
                  {t('直接解析')}
                </Button>
                <Button
                  variant="filled"
                  leftSection={<ExternalLink size={16} />}
                  onClick={handleBrowserLogin}
                  loading={loading && source === 'browser'}
                >
                  {t('浏览器登录')}
                </Button>
              </Group>
              <Text size="xs" c="dimmed">
                {t('需要登录的教务系统请选择「浏览器登录」，在弹出的窗口中登录后点击「提取课表」按钮。')}
              </Text>
            </Stack>

            {error && (
              <Alert icon={<AlertCircle size={16} />} color="red" title={t('错误')}>
                {error}
              </Alert>
            )}
          </Stack>
        </Stepper.Step>

        <Stepper.Step label={t('编辑导入数据')}>
          <Stack gap="md" py="md">
            {warnings.length > 0 && (
              <Alert color="yellow">
                {warnings.map((w, i) => <div key={i}>{w}</div>)}
              </Alert>
            )}
            <ImportPreviewTable
              drafts={drafts}
              onChange={setDrafts}
            />
            <Group justify="space-between">
              <Button variant="subtle" onClick={reset}>{t('重新选择')}</Button>
              <Group>
                <Button variant="subtle" onClick={handleClose}>{t('取消')}</Button>
                <Button onClick={handleCommit} loading={loading}>
                  {t('导入')} ({drafts.filter(d => d.valid).length} {t('条')})
                </Button>
              </Group>
            </Group>
          </Stack>
        </Stepper.Step>

        <Stepper.Completed>
          <Stack gap="md" py="md" align="center">
            <Text size="lg" fw={600}>✅ {t('导入完成')}</Text>
            {result && (
              <>
                <Text>{t('成功导入')} {result.createdCount} {t('条课程')}</Text>
                {result.skippedCount > 0 && (
                  <Text c="dimmed">{t('跳过')} {result.skippedCount} {t('条无效记录')}</Text>
                )}
              </>
            )}
            <Button onClick={handleClose}>{t('完成')}</Button>
          </Stack>
        </Stepper.Completed>
      </Stepper>
    </Modal>
  );
}