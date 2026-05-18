/**
 * Color system for CLI - Orange & Grey palette
 * Professional, accessible colors for terminal UI
 */

import chalk from 'chalk';

// Orange (Primary/Accent)
export const orange = {
  bright: chalk.hex('#FF8C00'), // High contrast
  normal: chalk.hex('#FFA500'), // Standard
  dim: chalk.hex('#CC8400'), // Muted
};

// Grey (UI/Secondary)
export const grey = {
  lightest: chalk.hex('#D3D3D3'), // Borders/dividers (light backgrounds)
  light: chalk.hex('#808080'), // Secondary text (darker for light backgrounds)
  normal: chalk.gray, // Inactive items
  dark: chalk.hex('#505050'), // Subtle emphasis
  darkest: chalk.hex('#303030'), // Backgrounds
};

// Semantic colors (standard)
export const semantic = {
  error: chalk.red,
  success: chalk.green,
  warning: chalk.yellow,
  info: orange.normal,
};

// Color names for Ink components (using hex strings)
export const inkColors = {
  orange: '#FFA500',
  orangeBright: '#FF8C00',
  orangeDim: '#CC8400',
  grey: 'gray',
  greyLight: '#808080', // Darker for better contrast on light backgrounds
  greyDark: '#505050',
};

// Text style helpers
export const text = {
  title: (str: string) => orange.normal.bold(str),
  heading: (str: string) => orange.normal(str),
  primary: (str: string) => str, // Use terminal default (works on light/dark)
  secondary: (str: string) => grey.light(str),
  accent: (str: string) => orange.normal(str),
  inactive: (str: string) => grey.normal(str),
  error: (str: string) => semantic.error(str),
  success: (str: string) => semantic.success(str),
  warning: (str: string) => semantic.warning(str),
  info: (str: string) => semantic.info(str),
};

// Symbols (better than plain text)
export const symbols = {
  selected: '▶',
  bullet: '•',
  check: '✓',
  cross: '✗',
  warning: '⚠',
  info: 'ℹ',
  arrow: '→',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};

// Status colors for UI elements
export const status = {
  selected: inkColors.orange,
  active: inkColors.orange,
  inactive: inkColors.grey,
  disabled: inkColors.greyDark,
  border: {
    active: inkColors.orange,
    normal: inkColors.grey,
    error: 'red',
    success: 'green',
  },
};
