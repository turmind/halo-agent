import React from 'react'
import { Box, Text } from 'ink'

const LINES = [
  '  ██████╗  ███████╗  █████╗  ██╗   ██╗ ███████╗ ██████╗  ',
  '  ██╔══██╗ ██╔════╝ ██╔══██╗ ██║   ██║ ██╔════╝ ██╔══██╗ ',
  '  ██████╔╝ █████╗   ███████║ ██║   ██║ █████╗   ██████╔╝ ',
  '  ██╔══██╗ ██╔══╝   ██╔══██║ ╚██╗ ██╔╝ ██╔══╝   ██╔══██╗ ',
  '  ██████╔╝ ███████╗ ██║  ██║  ╚████╔╝  ███████╗ ██║  ██║ ',
  '  ╚═════╝  ╚══════╝ ╚═╝  ╚═╝   ╚═══╝   ╚══════╝ ╚═╝  ╚═╝ ',
]

const COLORS = ['#00d7ff', '#00d7ff', '#00afff', '#0087ff', '#005fff', '#005fdf']

export function Banner(): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {LINES.map((line, i) => (
        <Text key={i} color={COLORS[i]}>{line}</Text>
      ))}
    </Box>
  )
}
