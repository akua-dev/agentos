'use client';

import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from 'fumadocs-ui/components/dialog/search';
import { useDocsSearch } from 'fumadocs-core/search/client';
import { fetchClient } from 'fumadocs-core/search/client/fetch';

export default function AgentOSSearchDialog(props: SharedProps) {
  const { search, setSearch, query } = useDocsSearch({
    client: fetchClient(),
  });

  return (
    <SearchDialog search={search} onSearchChange={setSearch} isLoading={query.isLoading} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput placeholder="Search Docs and Learn" />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList items={Array.isArray(query.data) ? query.data : null} />
      </SearchDialogContent>
    </SearchDialog>
  );
}
