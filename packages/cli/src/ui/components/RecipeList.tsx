/**
 * RecipeList component — renders available fitness recipes.
 */

import { Text, Box } from 'ink';
import React from 'react';

import { useTheme } from '../theme.js';

interface RecipeEntry {
  readonly name: string;
  readonly description: string;
  readonly checkCount: string;
}

export interface RecipeListProps {
  readonly recipes: readonly RecipeEntry[];
}

export function RecipeList({ recipes }: RecipeListProps): React.ReactElement {
  const theme = useTheme();

  return (
    <Box flexDirection="column">
      <Text bold>Available Recipes</Text>
      <Text> </Text>
      {recipes.map((recipe) => (
        <Text key={recipe.name}>
          {'  '}
          <Text color={theme.brand}>{recipe.name}</Text>
          {' '}
          <Text dimColor>{'\u2014'}</Text>
          {' '}
          {recipe.description}
          {' '}
          <Text dimColor>({recipe.checkCount})</Text>
        </Text>
      ))}
    </Box>
  );
}
