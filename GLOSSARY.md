# Charts

Charts is the system catalog of Nautilus. It records which repositories exist, which systems they form, which external services they use, and how they depend on each other.

## Catalog entries

**System**:
A named bundle of Repositories that together form one product or platform, for example Nautilus.
_Avoid_: Project, group, collection

**Repository**:
A Git repository registered in Charts. It belongs to at most one System and one Named catalog.
_Avoid_: Repo, project, codebase

**Named catalog**:
A named set of System, Repository, and External entries, such as `work` or `personal`. A Repository belongs to one Named catalog, and entry IDs are unique across all Named catalogs.
_Avoid_: Volume, shelf, profile

**Independent repository**:
A Repository that belongs to no System because it is not part of any product or platform, for example a personal tool.
_Avoid_: Personal system, standalone, misc

**Repository key**:
The short uppercase code that starts every change ID of one Repository, for example `NBR`. It never changes once a change uses it.
_Avoid_: Prefix, project key

**Ticket key**:
The uppercase code for a project in an external ticket tracker, such as `ABC` in `ABC-1234`. It may be set on a System or Repository; a Repository's own value takes precedence, and several entries may share it.
_Avoid_: Scope key, project key, ticket prefix

**External**:
A specific service outside the catalog that a Repository uses, for example Amazon S3. It names the service, not only its provider.
_Avoid_: Third party, integration, provider

## Relationships

**Dependency**:
A directed connection from a Repository to another Repository or External that it uses in order to work. Only mentioning another entry's ID is not a Dependency.
_Avoid_: Reference, link, relation

**System dependency**:
A connection between two Systems that follows from the Dependencies of their Repositories. It is never recorded on its own.

## Nautilus

**Module**:
A part of Nautilus with its own repository, for example the Bridge, Charts, the Library, or the Logbook. Each Module is a Repository in the Nautilus System.
_Avoid_: Component, service

## People

**Catalog owner**:
The person who owns the Named catalogs and confirms each write an agent proposes.
_Avoid_: Owner (unqualified), user

**System owner**:
The team or person responsible for a System, recorded in its `owner` field.
_Avoid_: Owner (unqualified), maintainer

**Repository owner**:
The team or person responsible for a Repository, recorded in its `owner` field.
_Avoid_: Owner (unqualified), maintainer

## Machine

**Local path**:
A folder on one machine where Charts finds a Repository or a Named catalog. Each machine records its own.
_Avoid_: Checkout, working copy, clone, main local copy

**Folio**:
The `folio/` folder in the Charts root that holds the local repositories of Named catalogs, one child folder per catalog, for example `folio/work/`. A Folio is not itself a Named catalog, and the Charts source repository ignores it.
_Avoid_: Catalog folder, catalogs directory, workspace
