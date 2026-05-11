-- Mike one-shot schema (Microsoft SQL Server / Azure SQL).
-- Auth is handled by the Express backend (bcrypt + JWT). No RLS — the
-- backend is the sole DB client and enforces access in app code. JSON
-- columns are stored as nvarchar(max); the backend serialises/parses
-- them on read and write.
--
-- Run against a fresh `mike` database. If running interactively in SSMS,
-- make sure you're connected to the `mike` database first (use [mike]).

-- ---------------------------------------------------------------------------
-- Users (auth)
-- ---------------------------------------------------------------------------

if object_id('dbo.users', 'U') is null
  create table dbo.users (
    id uniqueidentifier not null primary key default newid(),
    email nvarchar(320) not null,
    password_hash nvarchar(200) not null,
    created_at datetimeoffset not null default sysdatetimeoffset(),
    updated_at datetimeoffset not null default sysdatetimeoffset(),
    constraint uq_users_email unique (email)
  );

if not exists (select 1 from sys.indexes where name = 'idx_users_email_lower')
  create index idx_users_email_lower on dbo.users (email);

-- ---------------------------------------------------------------------------
-- User profiles
-- ---------------------------------------------------------------------------

if object_id('dbo.user_profiles', 'U') is null
  create table dbo.user_profiles (
    id uniqueidentifier not null primary key default newid(),
    user_id uniqueidentifier not null unique
      references dbo.users(id) on delete cascade,
    display_name nvarchar(200) null,
    organisation nvarchar(200) null,
    tier nvarchar(50) not null default 'Free',
    message_credits_used int not null default 0,
    credits_reset_date datetimeoffset not null default dateadd(day, 30, sysdatetimeoffset()),
    tabular_model nvarchar(100) not null default 'azure-gpt-4.1-mini',
    claude_api_key nvarchar(500) null,
    gemini_api_key nvarchar(500) null,
    created_at datetimeoffset not null default sysdatetimeoffset(),
    updated_at datetimeoffset not null default sysdatetimeoffset()
  );

if not exists (select 1 from sys.indexes where name = 'idx_user_profiles_user')
  create index idx_user_profiles_user on dbo.user_profiles(user_id);

-- ---------------------------------------------------------------------------
-- Projects and documents
-- ---------------------------------------------------------------------------

if object_id('dbo.projects', 'U') is null
  create table dbo.projects (
    id uniqueidentifier not null primary key default newid(),
    user_id nvarchar(100) not null,
    name nvarchar(500) not null,
    cm_number nvarchar(100) null,
    visibility nvarchar(50) not null default 'private',
    shared_with nvarchar(max) not null default '[]',
    created_at datetimeoffset not null default sysdatetimeoffset(),
    updated_at datetimeoffset not null default sysdatetimeoffset()
  );

if not exists (select 1 from sys.indexes where name = 'idx_projects_user')
  create index idx_projects_user on dbo.projects(user_id);

if object_id('dbo.project_subfolders', 'U') is null
  create table dbo.project_subfolders (
    id uniqueidentifier not null primary key default newid(),
    project_id uniqueidentifier not null
      references dbo.projects(id) on delete cascade,
    user_id nvarchar(100) not null,
    name nvarchar(500) not null,
    parent_folder_id uniqueidentifier null
      references dbo.project_subfolders(id),
    created_at datetimeoffset not null default sysdatetimeoffset(),
    updated_at datetimeoffset not null default sysdatetimeoffset()
  );

if not exists (select 1 from sys.indexes where name = 'idx_project_subfolders_project')
  create index idx_project_subfolders_project on dbo.project_subfolders(project_id);

if object_id('dbo.documents', 'U') is null
  create table dbo.documents (
    id uniqueidentifier not null primary key default newid(),
    project_id uniqueidentifier null
      references dbo.projects(id) on delete cascade,
    user_id nvarchar(100) not null,
    filename nvarchar(500) not null,
    file_type nvarchar(100) null,
    size_bytes bigint not null default 0,
    page_count int null,
    structure_tree nvarchar(max) null,
    status nvarchar(50) not null default 'pending',
    folder_id uniqueidentifier null
      references dbo.project_subfolders(id) on delete no action,
    current_version_id uniqueidentifier null,
    created_at datetimeoffset not null default sysdatetimeoffset(),
    updated_at datetimeoffset not null default sysdatetimeoffset()
  );

if not exists (select 1 from sys.indexes where name = 'idx_documents_user_project')
  create index idx_documents_user_project on dbo.documents(user_id, project_id);

if not exists (select 1 from sys.indexes where name = 'idx_documents_project_folder')
  create index idx_documents_project_folder on dbo.documents(project_id, folder_id);

if object_id('dbo.document_versions', 'U') is null
  create table dbo.document_versions (
    id uniqueidentifier not null primary key default newid(),
    document_id uniqueidentifier not null
      references dbo.documents(id) on delete cascade,
    storage_path nvarchar(1000) not null,
    pdf_storage_path nvarchar(1000) null,
    source nvarchar(50) not null default 'upload'
      check (source in (
        'upload', 'user_upload', 'assistant_edit',
        'user_accept', 'user_reject', 'generated'
      )),
    version_number int null,
    display_name nvarchar(500) null,
    created_at datetimeoffset not null default sysdatetimeoffset()
  );

if not exists (select 1 from sys.indexes where name = 'idx_document_versions_document_id')
  create index idx_document_versions_document_id
    on dbo.document_versions(document_id, created_at desc);

if not exists (select 1 from sys.indexes where name = 'idx_document_versions_doc_vnum')
  create index idx_document_versions_doc_vnum
    on dbo.document_versions(document_id, version_number);

-- The current_version_id FK is added after document_versions is created
-- to break the cycle. Note: SQL Server forbids ON DELETE SET NULL on a
-- circular path, so we leave it as NO ACTION here and clear it in app code
-- when needed.
if not exists (
  select 1 from sys.foreign_keys where name = 'fk_documents_current_version'
)
  alter table dbo.documents
    add constraint fk_documents_current_version
    foreign key (current_version_id) references dbo.document_versions(id);

if object_id('dbo.document_edits', 'U') is null
  create table dbo.document_edits (
    id uniqueidentifier not null primary key default newid(),
    document_id uniqueidentifier not null
      references dbo.documents(id) on delete cascade,
    chat_message_id uniqueidentifier null,
    version_id uniqueidentifier not null
      references dbo.document_versions(id) on delete no action,
    change_id nvarchar(100) not null,
    del_w_id nvarchar(100) null,
    ins_w_id nvarchar(100) null,
    deleted_text nvarchar(max) not null default '',
    inserted_text nvarchar(max) not null default '',
    context_before nvarchar(max) null,
    context_after nvarchar(max) null,
    status nvarchar(50) not null default 'pending'
      check (status in ('pending', 'accepted', 'rejected')),
    created_at datetimeoffset not null default sysdatetimeoffset(),
    resolved_at datetimeoffset null
  );

if not exists (select 1 from sys.indexes where name = 'idx_document_edits_document_id')
  create index idx_document_edits_document_id
    on dbo.document_edits(document_id, created_at desc);

if not exists (select 1 from sys.indexes where name = 'idx_document_edits_message_id')
  create index idx_document_edits_message_id on dbo.document_edits(chat_message_id);

if not exists (select 1 from sys.indexes where name = 'idx_document_edits_version_id')
  create index idx_document_edits_version_id on dbo.document_edits(version_id);

-- ---------------------------------------------------------------------------
-- Workflows
-- ---------------------------------------------------------------------------

if object_id('dbo.workflows', 'U') is null
  create table dbo.workflows (
    id uniqueidentifier not null primary key default newid(),
    user_id nvarchar(100) null,
    title nvarchar(500) not null,
    type nvarchar(50) not null,
    prompt_md nvarchar(max) null,
    columns_config nvarchar(max) null,
    practice nvarchar(200) null,
    is_system bit not null default 0,
    created_at datetimeoffset not null default sysdatetimeoffset()
  );

if not exists (select 1 from sys.indexes where name = 'idx_workflows_user')
  create index idx_workflows_user on dbo.workflows(user_id);

if object_id('dbo.hidden_workflows', 'U') is null
  create table dbo.hidden_workflows (
    id uniqueidentifier not null primary key default newid(),
    user_id nvarchar(100) not null,
    workflow_id nvarchar(100) not null,
    created_at datetimeoffset not null default sysdatetimeoffset(),
    constraint uq_hidden_workflows unique (user_id, workflow_id)
  );

if not exists (select 1 from sys.indexes where name = 'idx_hidden_workflows_user')
  create index idx_hidden_workflows_user on dbo.hidden_workflows(user_id);

if object_id('dbo.workflow_shares', 'U') is null
  create table dbo.workflow_shares (
    id uniqueidentifier not null primary key default newid(),
    workflow_id uniqueidentifier not null
      references dbo.workflows(id) on delete cascade,
    shared_by_user_id nvarchar(100) not null,
    shared_with_email nvarchar(320) not null,
    allow_edit bit not null default 0,
    created_at datetimeoffset not null default sysdatetimeoffset(),
    constraint uq_workflow_shares unique (workflow_id, shared_with_email)
  );

if not exists (select 1 from sys.indexes where name = 'idx_workflow_shares_workflow_id')
  create index idx_workflow_shares_workflow_id on dbo.workflow_shares(workflow_id);

if not exists (select 1 from sys.indexes where name = 'idx_workflow_shares_email')
  create index idx_workflow_shares_email on dbo.workflow_shares(shared_with_email);

-- ---------------------------------------------------------------------------
-- Assistant chats
-- ---------------------------------------------------------------------------

if object_id('dbo.chats', 'U') is null
  create table dbo.chats (
    id uniqueidentifier not null primary key default newid(),
    project_id uniqueidentifier null
      references dbo.projects(id) on delete cascade,
    user_id nvarchar(100) not null,
    title nvarchar(500) null,
    created_at datetimeoffset not null default sysdatetimeoffset()
  );

if not exists (select 1 from sys.indexes where name = 'idx_chats_user')
  create index idx_chats_user on dbo.chats(user_id);

if not exists (select 1 from sys.indexes where name = 'idx_chats_project')
  create index idx_chats_project on dbo.chats(project_id);

if object_id('dbo.chat_messages', 'U') is null
  create table dbo.chat_messages (
    id uniqueidentifier not null primary key default newid(),
    chat_id uniqueidentifier not null
      references dbo.chats(id) on delete cascade,
    role nvarchar(50) not null,
    content nvarchar(max) null,
    files nvarchar(max) null,
    annotations nvarchar(max) null,
    workflow nvarchar(max) null,
    created_at datetimeoffset not null default sysdatetimeoffset()
  );

if not exists (select 1 from sys.indexes where name = 'idx_chat_messages_chat')
  create index idx_chat_messages_chat on dbo.chat_messages(chat_id);

if not exists (
  select 1 from sys.foreign_keys where name = 'fk_document_edits_chat_message'
)
  alter table dbo.document_edits
    add constraint fk_document_edits_chat_message
    foreign key (chat_message_id) references dbo.chat_messages(id)
    on delete no action;

-- ---------------------------------------------------------------------------
-- Tabular reviews
-- ---------------------------------------------------------------------------

if object_id('dbo.tabular_reviews', 'U') is null
  create table dbo.tabular_reviews (
    id uniqueidentifier not null primary key default newid(),
    project_id uniqueidentifier null
      references dbo.projects(id) on delete cascade,
    user_id nvarchar(100) not null,
    title nvarchar(500) null,
    columns_config nvarchar(max) null,
    workflow_id uniqueidentifier null
      references dbo.workflows(id) on delete set null,
    practice nvarchar(200) null,
    shared_with nvarchar(max) not null default '[]',
    created_at datetimeoffset not null default sysdatetimeoffset(),
    updated_at datetimeoffset not null default sysdatetimeoffset()
  );

if not exists (select 1 from sys.indexes where name = 'idx_tabular_reviews_user')
  create index idx_tabular_reviews_user on dbo.tabular_reviews(user_id);

if not exists (select 1 from sys.indexes where name = 'idx_tabular_reviews_project')
  create index idx_tabular_reviews_project on dbo.tabular_reviews(project_id);

if object_id('dbo.tabular_cells', 'U') is null
  create table dbo.tabular_cells (
    id uniqueidentifier not null primary key default newid(),
    review_id uniqueidentifier not null
      references dbo.tabular_reviews(id) on delete cascade,
    document_id uniqueidentifier not null
      references dbo.documents(id) on delete no action,
    column_index int not null,
    content nvarchar(max) null,
    citations nvarchar(max) null,
    status nvarchar(50) not null default 'pending',
    created_at datetimeoffset not null default sysdatetimeoffset()
  );

if not exists (select 1 from sys.indexes where name = 'idx_tabular_cells_review')
  create index idx_tabular_cells_review
    on dbo.tabular_cells(review_id, document_id, column_index);

if object_id('dbo.tabular_review_chats', 'U') is null
  create table dbo.tabular_review_chats (
    id uniqueidentifier not null primary key default newid(),
    review_id uniqueidentifier not null
      references dbo.tabular_reviews(id) on delete cascade,
    user_id nvarchar(100) not null,
    title nvarchar(500) null,
    created_at datetimeoffset not null default sysdatetimeoffset(),
    updated_at datetimeoffset not null default sysdatetimeoffset()
  );

if not exists (select 1 from sys.indexes where name = 'idx_tabular_review_chats_review')
  create index idx_tabular_review_chats_review
    on dbo.tabular_review_chats(review_id, updated_at desc);

if not exists (select 1 from sys.indexes where name = 'idx_tabular_review_chats_user')
  create index idx_tabular_review_chats_user on dbo.tabular_review_chats(user_id);

if object_id('dbo.tabular_review_chat_messages', 'U') is null
  create table dbo.tabular_review_chat_messages (
    id uniqueidentifier not null primary key default newid(),
    chat_id uniqueidentifier not null
      references dbo.tabular_review_chats(id) on delete cascade,
    role nvarchar(50) not null,
    content nvarchar(max) null,
    annotations nvarchar(max) null,
    created_at datetimeoffset not null default sysdatetimeoffset()
  );

if not exists (select 1 from sys.indexes where name = 'idx_tabular_review_chat_messages_chat')
  create index idx_tabular_review_chat_messages_chat
    on dbo.tabular_review_chat_messages(chat_id, created_at);
