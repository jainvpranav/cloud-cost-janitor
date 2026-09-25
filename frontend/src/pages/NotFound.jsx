import React from 'react';
import { useNavigate } from 'react-router-dom';

import { Icon } from '../components/Icons';
import { Button, Card, CardBody } from '../components/UI';

export const NotFound = () => {
  const navigate = useNavigate();
  return (
    <div className="app-body">
      <div className="row" style={{ justifyContent: 'center', padding: 'var(--s-12) 0' }}>
        <Card style={{ maxWidth: 480, width: '100%' }}>
          <CardBody className="stack stack-6" style={{ textAlign: 'center', alignItems: 'center' }}>
            <span
              className="stat-icon"
              style={{ width: 48, height: 48, background: 'var(--brand-subtle)', color: 'var(--brand-fg)' }}
            >
              <Icon name="search" size={22} />
            </span>
            <div>
              <h2 style={{ fontSize: 'var(--fs-xl)' }}>Page not found</h2>
              <p className="t-sm t-dim" style={{ marginTop: 6 }}>
                That route does not exist. It may have been renamed, or the link may be stale.
              </p>
            </div>
            <div className="row row-5 row-wrap" style={{ justifyContent: 'center' }}>
              <Button variant="primary" icon="dashboard" onClick={() => navigate('/')}>
                Dashboard
              </Button>
              <Button variant="secondary" icon="book" onClick={() => navigate('/docs')}>
                How it works
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
};
