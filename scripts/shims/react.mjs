/**
 * Test shim for `react`.
 *
 * The client half is a browser bundle; the Host-side tests only ever touch the pure modules
 * it imports from. This shim exists so those modules can be loaded under Node without a
 * React install, and it deliberately implements the smallest set of hooks that lets a
 * component be invoked directly as a function.
 *
 * It is not a renderer. Anything asserting on markup should test the element tree that
 * `createElement` builds, not a rendered string.
 */

/** Marks objects produced by `createElement`. */
export const kElement = Symbol.for('dsh-evermemory.react-element-stub')

let hookIndex = 0
let hookState = []
let rerender = () => {}

/**
 * Build an element description.
 *
 * @param type - a tag name or component.
 * @param props - the element's props.
 * @param children - child elements.
 * @returns an element description.
 */
export function createElement(type, props, ...children) {
  return {
    [kElement]: true,
    type,
    props: {
      ...(props ?? {}),
      ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
    },
  }
}

/**
 * Read or set one hook slot.
 *
 * @param initial - the initial value.
 * @returns the current value and its setter.
 */
export function useState(initial) {
  const index = hookIndex
  if (hookState.length <= index) hookState.push(typeof initial === 'function' ? initial() : initial)
  hookIndex += 1

  const set = (next) => {
    hookState[index] = typeof next === 'function' ? next(hookState[index]) : next
    rerender()
  }

  return [hookState[index], set]
}

/**
 * Run an effect immediately, once per render.
 *
 * @param body - the effect body.
 * @param deps - dependency list; a changed entry re-runs the effect.
 */
export function useEffect(body, deps) {
  const index = hookIndex
  hookIndex += 1
  const previous = hookState[index]
  const changed = previous === undefined || deps === undefined || deps.some((value, at) => value !== previous[at])
  if (!changed) return
  hookState[index] = deps === undefined ? [] : [...deps]
  body()
}

/** Reset the hook store. @param onRerender - what a state setter should trigger. */
export function __resetHooks(onRerender = () => {}) {
  hookIndex = 0
  hookState = []
  rerender = onRerender
}

/** Begin a render pass; call before invoking a component directly. */
export function __beginRender() {
  hookIndex = 0
}

const React = { createElement, useState, useEffect }

export default React
