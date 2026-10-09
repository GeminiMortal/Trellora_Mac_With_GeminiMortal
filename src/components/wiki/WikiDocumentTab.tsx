import { t, useI18n } from '../../i18n';
import { Badge, Button, Group, ScrollArea, Text, Tooltip } from '@mantine/core';
import { BookmarkPlus, ExternalLink, FileText } from 'lucide-react';
import MarkdownContent from '../MarkdownContent';
import type { WikiMapNode } from '../../wiki/wikiTypes';
import type { ResolvedTheme } from '../../utils/theme';

interface WikiDocumentTabProps {
  node: WikiMapNode;
  pathLabel: string;
  resolvedTheme: ResolvedTheme;
  onOpenInNotes?: () => void;
  onOpenSectionInNotes?: () => void;
}

export default function WikiDocumentTab({ node, pathLabel, resolvedTheme, onOpenInNotes, onOpenSectionInNotes }: WikiDocumentTabProps) {
  useI18n();
  return (
    <div className="wiki-document-tab">
      <div className="wiki-document-meta">
        <Group gap={7} wrap="wrap">
          <Badge variant="light" color="gray" leftSection={<FileText size={11} />}>{t("只读")}</Badge>
          <Text size="xs" c="dimmed">{node.sourceRef.sourceName}</Text>
        </Group>
        <Text className="wiki-node-path" size="xs" c="dimmed" mt={7}>{pathLabel}</Text>
      </div>
      <ScrollArea className="wiki-document-scroll" type="auto">
        <MarkdownContent content={node.markdown} resolvedTheme={resolvedTheme} className="wiki-markdown-content" showCodeCopyActions />
      </ScrollArea>
      <div className="wiki-document-actions">
        <Tooltip label={onOpenInNotes ? t("选择笔记库并打开文档正文") : t("当前文档未连接可用的资料库来源")} withArrow>
          <span>
            <Button size="xs" variant="default" leftSection={<ExternalLink size={14} />} disabled={!onOpenInNotes} onClick={onOpenInNotes}>
              {t("在笔记中打开")}
            </Button>
          </span>
        </Tooltip>
        <Tooltip label={onOpenSectionInNotes ? t("把此章节（含子章节）保存为可编辑笔记") : t("当前文档未连接可用的资料库来源")} withArrow>
          <span>
            <Button size="xs" variant="default" leftSection={<BookmarkPlus size={14} />} disabled={!onOpenSectionInNotes} onClick={onOpenSectionInNotes}>
              {t("存为章节笔记")}
            </Button>
          </span>
        </Tooltip>
      </div>
    </div>
  );
}
