export const libraryKinds = { article: "文章与讲义", essay: "作文批改", word: "单词", phrase: "词组", sentence: "整句" } as const;
export type LibraryKind = keyof typeof libraryKinds;
export type LibraryFolder = { id: string; name: string; parentId: string | null };
export type LibraryEntry = { key: string; title: string; kind: LibraryKind; content: string; meaning: string; preview: string; sourceTitle: string; sourceIds: string[]; markIds: string[]; sourceRef?: string; sourceFileId?: string; thumbnailUrl?: string; aliases: string[]; tags: string[]; folderIds: string[]; favorite: boolean; pinned: boolean; characters: number; createdAt: string };
export type LibraryCatalog = { entries: LibraryEntry[]; folders: LibraryFolder[]; total: number; expressionCount: number; updatedAt: string };
