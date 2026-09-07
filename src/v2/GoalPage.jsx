import React from 'react';
import GoalWorkspace from './GoalWorkspace.jsx';
import './goalStyles.css';
export { GOAL_RECIPE } from './goalDefaults.js';
export default function GoalPage(props) { return <GoalWorkspace key={props.projectId} {...props}/>; }
