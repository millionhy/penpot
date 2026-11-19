// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

// The subset of `app.common.files.changes` the builder emits. Changes are
// applied to the file data in place of the full change pipeline: the
// builder only produces `add-page`, `add-obj`, `mod-obj`, `del-obj`,
// `add-color`, `add-typography`, `add-component` and `set-tokens-lib`.

import type {
  FileData,
  LibraryColor,
  LibraryTypography,
  Page,
  Shape,
  Uuid,
} from "./model.ts";
import { ROOT_ID, now } from "./files.ts";
import { fail } from "./errors.ts";

export interface SetOperation {
  type: "set";
  attr: string;
  val: unknown;
}

export interface Change {
  type: string;
  pageId?: Uuid;
  componentId?: Uuid;
  [attr: string]: unknown;
}

interface Container {
  objects: Record<Uuid, Shape>;
}

function withPage(data: FileData, pageId: Uuid, f: (page: Page) => Page): FileData {
  const page = data.pagesIndex[pageId];
  if (page == null) return data;
  return {
    ...data,
    pagesIndex: { ...data.pagesIndex, [pageId]: f(page) },
  };
}

function withObjects(
  data: FileData,
  change: Change,
  f: (container: Container) => Container,
): FileData {
  if (change.pageId != null) {
    return withPage(data, change.pageId, (page) =>
      f(page as unknown as Container) as unknown as Page,
    );
  }

  const componentId = change.componentId;
  const components = data.components;
  if (componentId == null || components == null) return data;
  const component = components[componentId];
  if (component == null) return data;

  return {
    ...data,
    components: {
      ...components,
      [componentId]: f(component as unknown as Container) as unknown as Record<
        string,
        unknown
      >,
    },
  };
}

function addShape(
  container: Container,
  params: {
    id: Uuid;
    obj: Shape;
    frameId?: Uuid | null;
    parentId?: Uuid | null;
    index?: number | null;
  },
): Container {
  const { id, obj, index = null } = params;

  const parentId = params.parentId ?? params.frameId ?? null;
  const resolvedParent =
    parentId != null && container.objects[parentId] != null ? parentId : ROOT_ID;
  const resolvedFrame =
    params.frameId != null && container.objects[params.frameId] != null
      ? params.frameId
      : ROOT_ID;

  const objects: Record<Uuid, Shape> = {
    ...container.objects,
    [id]: { ...obj, id, parentId: resolvedParent, frameId: resolvedFrame },
  };

  const parent = objects[resolvedParent];
  if (parent != null) {
    const shapes = Array.isArray(parent.shapes) ? [...parent.shapes] : [];
    if (!shapes.includes(id)) {
      if (index == null) shapes.push(id);
      else shapes.splice(index, 0, id);
    }
    objects[resolvedParent] = { ...parent, shapes };
  }

  return { ...container, objects };
}

function applyOperations(shape: Shape, operations: unknown): Shape {
  if (!Array.isArray(operations)) return shape;

  let result: Record<string, unknown> = { ...shape };
  for (const operation of operations as SetOperation[]) {
    if (operation.type !== "set") continue;
    result = { ...result, [operation.attr]: operation.val };
  }
  return result as unknown as Shape;
}

function deleteShape(container: Container, id: Uuid): Container {
  const target = container.objects[id];
  if (target == null) return container;

  const objects = { ...container.objects };
  const stack = [id];

  while (stack.length > 0) {
    const current = stack.pop() as Uuid;
    const shape = objects[current];
    if (shape == null) continue;
    delete objects[current];
    if (Array.isArray(shape.shapes)) stack.push(...shape.shapes);
  }

  const parentId = target.parentId ?? target.frameId;
  const parent = objects[parentId];
  if (parent != null) {
    objects[parentId] = {
      ...parent,
      shapes: (parent.shapes ?? []).filter((child) => child !== id),
    };
  }

  return { ...container, objects };
}

function touch<T extends Record<string, unknown>>(obj: T): T {
  return { ...obj, modifiedAt: now() };
}

export function applyChange(data: FileData, change: Change): FileData {
  switch (change.type) {
    case "add-page": {
      const page = change.page as Page;
      const pages = data.pages.includes(page.id)
        ? data.pages
        : [...data.pages, page.id];
      return {
        ...data,
        pages,
        pagesIndex: { ...data.pagesIndex, [page.id]: page },
      };
    }

    case "add-obj": {
      return withObjects(data, change, (container) =>
        addShape(container, {
          id: change.id as Uuid,
          obj: change.obj as Shape,
          frameId: change.frameId as Uuid | null | undefined,
          parentId: change.parentId as Uuid | null | undefined,
          index: change.index as number | null | undefined,
        }),
      );
    }

    case "mod-obj": {
      return withObjects(data, change, (container) => {
        const id = change.id as Uuid;
        const shape = container.objects[id];
        if (shape == null) return container;
        return {
          ...container,
          objects: {
            ...container.objects,
            [id]: applyOperations(shape, change.operations),
          },
        };
      });
    }

    case "del-obj": {
      return withObjects(data, change, (container) =>
        deleteShape(container, change.id as Uuid),
      );
    }

    case "add-color": {
      const color = touch(change.color as LibraryColor);
      return { ...data, colors: { ...data.colors, [color.id]: color } };
    }

    case "add-typography": {
      const typography = touch(change.typography as LibraryTypography);
      return {
        ...data,
        typographies: {
          ...data.typographies,
          [typography.id]: typography,
        },
      };
    }

    case "add-component": {
      const id = change.id as Uuid;
      const component: Record<string, unknown> = touch({
        id,
        name: change.name as string,
        path: change.path as string,
      });

      if (change.mainInstanceId != null) {
        component.mainInstanceId = change.mainInstanceId;
      }
      if (change.mainInstancePage != null) {
        component.mainInstancePage = change.mainInstancePage;
      }
      if (change.annotation != null) component.annotation = change.annotation;
      if (change.variantId != null) component.variantId = change.variantId;
      if (change.variantProperties != null) {
        component.variantProperties = change.variantProperties;
      }

      return {
        ...data,
        components: { ...data.components, [id]: component },
      };
    }

    case "set-tokens-lib": {
      return { ...data, tokensLib: change.tokensLib };
    }

    default:
      fail("validation", "unknown-change", `unknown change type: ${change.type}`);
  }
}

export function processChanges(
  data: FileData,
  changes: readonly Change[],
): FileData {
  return changes.reduce(applyChange, data);
}
